import crypto from 'node:crypto';
import { MessageProcessor } from './message-processor.js';
import { TelegramUpdateIngester } from './supervisor-service/telegram-update-ingester.js';
import { SupervisorJobRunner } from './supervisor-service/job-runner.js';
import { OutboundMessageDispatcher } from './supervisor-service/outbound-dispatcher.js';
import { getToolConcurrencyLimit } from '../tools/tool-registry.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SupervisorService {
  constructor({
    db,
    telegramClient,
    agent,
    executionPlanner,
    codexRunner,
    config,
    memorySummarizer = null,
    audioTranscriber = null,
    conversationManager = null,
    logger = console,
    timers = { setInterval, clearInterval, sleep },
  }) {
    this.db = db;
    this.telegramClient = telegramClient;
    this.config = config;
    this.logger = logger;
    this.timers = timers;
    this.codexRunner = codexRunner;
    this.agent = agent;
    this.immediateSentMessages = 0;
    this.runningTaskExecutions = new Map();
    this.messageProcessor = new MessageProcessor({
      db,
      agent,
      executionPlanner,
      codexRunner,
      config,
      memorySummarizer,
      conversationManager,
      onAcknowledgementQueued: async () => {
        this.immediateSentMessages += await this.flushOutbound(1);
      },
    });
    this.updateIngester = new TelegramUpdateIngester({
      db,
      telegramClient,
      audioTranscriber,
      config,
      logger,
    });
    this.jobRunner = new SupervisorJobRunner({
      db,
      messageProcessor: this.messageProcessor,
      logger,
    });
    this.outboundDispatcher = new OutboundMessageDispatcher({
      db,
      telegramClient,
      logger,
    });
  }

  isAllowedChat(chatId) {
    return this.updateIngester.isAllowedChat(chatId);
  }

  async transcribeAudioMessage(_message, attachment) {
    return this.updateIngester.transcribeAudioMessage(attachment);
  }

  async ingestUpdates(updates) {
    return this.updateIngester.ingest(updates);
  }

  async processPendingJobs(limit) {
    return this.jobRunner.processPending(limit);
  }

  async flushOutbound(limit = 10) {
    return this.outboundDispatcher.flush(limit);
  }

  computeLeaseTtlMs() {
    return this.config.supervisorLeaseTtlMs ?? this.config.codexTimeoutMs + 60000;
  }

  computeLeaseHeartbeatMs(leaseTtlMs) {
    if (this.config.supervisorLeaseHeartbeatMs) {
      return this.config.supervisorLeaseHeartbeatMs;
    }

    return Math.max(1000, Math.floor(leaseTtlMs / 3));
  }

  getRunningTaskIds() {
    return [...this.runningTaskExecutions.keys()];
  }

  getRunningJobIds() {
    return [...this.runningTaskExecutions.values()]
      .map((entry) => entry.sourceJobId)
      .filter((value) => value != null);
  }

  countRunningTasksByTool() {
    const counts = new Map();

    for (const { toolType } of this.runningTaskExecutions.values()) {
      counts.set(toolType, (counts.get(toolType) ?? 0) + 1);
    }

    return counts;
  }

  async startEligibleQueuedTasks() {
    if (!this.config.allowBackgroundCodexTasks) {
      return 0;
    }

    const queuedTasks = this.db.listQueuedTasks(20);
    const runningCounts = this.countRunningTasksByTool();
    let started = 0;

    for (const task of queuedTasks) {
      if (this.runningTaskExecutions.has(task.id)) {
        continue;
      }

      const toolType = task.tool_type ?? 'codex';
      const limit = getToolConcurrencyLimit(toolType, this.config.taskToolConcurrency);
      const running = runningCounts.get(toolType) ?? 0;

      if (running >= limit) {
        continue;
      }

      this.launchTaskExecution(task);
      runningCounts.set(toolType, running + 1);
      started += 1;
    }

    return started;
  }

  launchTaskExecution(task) {
    const toolType = task.tool_type ?? 'codex';
    const promise = this.executeTaskInBackground(task)
      .catch((error) => {
        const message = error instanceof Error ? error.message : `${error}`;
        this.logger.error(`Background task ${task.id} failed unexpectedly: ${message}`);
      })
      .finally(() => {
        this.runningTaskExecutions.delete(task.id);
      });

    this.runningTaskExecutions.set(task.id, {
      promise,
      toolType,
      sourceJobId: task.source_job_id ?? null,
    });
  }

  async executeTaskInBackground(task) {
    if ((task.tool_type ?? 'codex') !== 'codex') {
      return;
    }

    const codexResult = await this.messageProcessor.codexTaskRunner.executeQueuedTask(task);

    if (!codexResult) {
      return;
    }

    const sourceMessage = task.source_message_id ? this.db.getMessageById(task.source_message_id) : null;
    const userText = task.execution_input?.userText ?? sourceMessage?.message_text ?? task.title;
    const userSummary =
      typeof this.agent?.summarizeCodexResult === 'function'
        ? await this.agent.summarizeCodexResult({
            chatId: task.notify_chat_id,
            workspaceRoot: this.config.workspaceRoot,
            userMessage: userText,
            codexResult,
          })
        : null;

    if (task.notify_chat_id) {
      this.db.queueOutboundMessage({
        chatId: task.notify_chat_id,
        text: this.messageProcessor.codexTaskRunner.formatResultMessage({
          ...codexResult,
          user_summary: userSummary,
        }),
        replyToMessageId: task.notify_reply_to_message_id ?? null,
      });
      await this.flushOutbound(1);
    }
  }

  async recoverAbandonedCodexProcess() {
    const activeRun = this.db.getActiveCodexRun();

    if (!activeRun?.pid) {
      return { found: false, killed: false };
    }

    if (activeRun.taskId && this.runningTaskExecutions.has(activeRun.taskId)) {
      return {
        found: true,
        killed: false,
        pid: activeRun.pid,
        taskId: activeRun.taskId ?? null,
        active: true,
      };
    }

    let killed = false;

    try {
      killed = await this.codexRunner.killProcessTree(activeRun.pid);
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`;
      this.logger.error(`Failed to terminate abandoned Codex process ${activeRun.pid}: ${message}`);
    } finally {
      this.db.clearActiveCodexRun();
    }

    if (killed) {
      this.logger.error(`Terminated abandoned Codex process tree for PID ${activeRun.pid}.`);
    }

    return {
      found: true,
      killed,
      pid: activeRun.pid,
      taskId: activeRun.taskId ?? null,
    };
  }

  async runOnce() {
    const owner = crypto.randomUUID();
    const leaseTtlMs = this.computeLeaseTtlMs();
    const leaseHeartbeatMs = this.computeLeaseHeartbeatMs(leaseTtlMs);
    const acquired = this.db.acquireLease('supervisor_once', owner, leaseTtlMs);

    if (!acquired) {
      this.logger.log('Another Soup AI run is still active. Skipping this tick.');
      return { skipped: true };
    }

    const recoveredProcess = await this.recoverAbandonedCodexProcess();
    const abandonedReason =
      'Recovered abandoned supervisor work after a previous run lost its lease before completing.';
    const recovered = this.db.failRunningWork(abandonedReason, {
      excludeTaskIds: this.getRunningTaskIds(),
      excludeJobIds: this.getRunningJobIds(),
    });

    if (recovered.failedJobs > 0 || recovered.failedTasks > 0) {
      this.logger.error(
        `Recovered abandoned work: ${recovered.failedJobs} job(s), ${recovered.failedTasks} task(s).`,
      );
    }

    const heartbeat = this.timers.setInterval(() => {
      const renewed = this.db.renewLease('supervisor_once', owner, leaseTtlMs);

      if (!renewed) {
        this.logger.error('Failed to renew supervisor lease; another run may take over after expiry.');
      }
    }, leaseHeartbeatMs);

    try {
      this.immediateSentMessages = 0;
      const offset = this.db.getCursor('telegram_updates_offset', 0);
      const updates = await this.telegramClient.getUpdates({
        offset,
        limit: this.config.telegramPollLimit,
        timeoutSeconds: this.config.telegramPollTimeoutSeconds,
      });

      const ingested = await this.ingestUpdates(updates);
      const processedJobs = await this.processPendingJobs(this.config.maxJobsPerRun);
      const startedTasks = await this.startEligibleQueuedTasks();
      const sentMessages = this.immediateSentMessages + (await this.flushOutbound(20));

      return {
        skipped: false,
        recoveredProcess,
        recovered,
        updatesReceived: updates.length,
        insertedMessages: ingested.inserted,
        processedJobs,
        startedTasks,
        sentMessages,
      };
    } finally {
      this.immediateSentMessages = 0;
      this.timers.clearInterval(heartbeat);
      this.db.releaseLease('supervisor_once', owner);
    }
  }
}
