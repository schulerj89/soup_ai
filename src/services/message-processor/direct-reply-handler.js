export class DirectReplyHandler {
  constructor({ db, agent, config, conversationManager, codexTaskRunner }) {
    this.db = db;
    this.agent = agent;
    this.config = config;
    this.conversationManager = conversationManager;
    this.codexTaskRunner = codexTaskRunner;
  }

  async reply({ job, message, text, plan }) {
    const { session } = await this.conversationManager.getSession(message.chat_id);
    const conversationState = this.conversationManager.getState(message.chat_id);

    if (typeof this.agent.answerDirectly === 'function') {
      return this.agent.answerDirectly({
        chatId: message.chat_id,
        workspaceRoot: this.config.workspaceRoot,
        messageText: text,
        session,
        responseOutline: plan.responseOutline,
        planReason: plan.reason,
        conversationMemory: conversationState.seedText,
        conversationStateTool: this.createConversationStateTool(message.chat_id),
        resetConversationTool: this.createResetConversationTool(message.chat_id),
      });
    }

    const result = await this.agent.handleMessage?.({
      chatId: message.chat_id,
      messageText: text,
      session,
      workspaceRoot: this.config.workspaceRoot,
      codexTool: this.createCodexTool(job, message),
      codexStatusTool: async () => this.codexTaskRunner.codexRunner.getStatus(),
      recentTasksTool: async () => this.listRecentTasks(),
      queueSnapshotTool: async () => this.db.getQueueSnapshot(),
      conversationStateTool: this.createConversationStateTool(message.chat_id),
      resetConversationTool: this.createResetConversationTool(message.chat_id),
    });

    return result?.text ?? 'No response text returned.';
  }

  createCodexTool(job, message) {
    return async (params) =>
      this.codexTaskRunner.execute({
        ...params,
        sourceJobId: job.id,
        sourceMessageId: message.id,
      });
  }

  createConversationStateTool(chatId) {
    return async () => this.conversationManager.getState(chatId);
  }

  createResetConversationTool(chatId) {
    return async ({ reason }) => {
      const { control } = await this.conversationManager.archiveAndReset(chatId, {
        reason,
        preserveMemory: true,
      });

      return {
        ok: true,
        conversation_generation: control.conversationGeneration,
        active_conversation_id: control.activeConversationId,
        memory_preserved: true,
      };
    };
  }

  listRecentTasks() {
    return this.db.listRecentTasks(10).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      result_summary: task.result_summary,
      created_at: task.created_at,
      completed_at: task.completed_at,
    }));
  }
}
