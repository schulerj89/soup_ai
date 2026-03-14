export class SupervisorJobRunner {
  constructor({ db, messageProcessor, logger }) {
    this.db = db;
    this.messageProcessor = messageProcessor;
    this.logger = logger;
  }

  async processPending(limit) {
    const jobs = this.db.listPendingJobs(limit);
    let processed = 0;

    for (const job of jobs) {
      this.db.markJobRunning(job.id);

      try {
        await this.messageProcessor.processJob(job);
        this.db.markJobCompleted(job.id);
        processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : `${error}`;
        this.db.markJobFailed(job.id, message);
        this.logger.error(`Job ${job.id} failed: ${message}`);
      }
    }

    return processed;
  }
}
