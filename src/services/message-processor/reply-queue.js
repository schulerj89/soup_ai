import { queueReplyParts } from './helpers.js';

export class ReplyQueue {
  constructor({ db }) {
    this.db = db;
  }

  queue(message) {
    queueReplyParts(this.db, message);
  }
}
