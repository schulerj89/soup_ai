import crypto from 'node:crypto';
import { MessageProcessor } from './message-processor.js';
import { TelegramUpdateIngester } from './supervisor-service/telegram-update-ingester.js';
import { SupervisorJobRunner } from './supervisor-service/job-runner.js';
import { OutboundMessageDispatcher } from './supervisor-service/outbound-dispatcher.js';

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
    logger = console,
    timers = { setInterval, clearInterval, sleep },
  }) {
    this.db = db;
    this.telegramClient = telegramClient;
    this.config = config;
    this.logger = logger;
    this.timers = timers;
    this.immediateSentMessages = 0;
    this.messageProcessor = new MessageProcessor({
      db,
      agent,
      executionPlanner,
      codexRunner,
      config,
      memorySummarizer,
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

  async transcribeAudioMessage(message, attachment) {
    void message;
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

  async runOnce() {
    const owner = crypto.randomUUID();
    const leaseTtlMs = this.computeLeaseTtlMs();
    const leaseHeartbeatMs = this.computeLeaseHeartbeatMs(leaseTtlMs);
    const acquired = this.db.acquireLease('supervisor_once', owner, leaseTtlMs);

    if (!acquired) {
      this.logger.log('Another Soup AI run is still active. Skipping this tick.');
      return { skipped: true };
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
      const sentMessages = this.immediateSentMessages + (await this.flushOutbound(20));

      return {
        skipped: false,
        updatesReceived: updates.length,
        insertedMessages: ingested.inserted,
        processedJobs,
        sentMessages,
      };
    } finally {
      this.immediateSentMessages = 0;
      this.timers.clearInterval(heartbeat);
      this.db.releaseLease('supervisor_once', owner);
    }
  }
}
