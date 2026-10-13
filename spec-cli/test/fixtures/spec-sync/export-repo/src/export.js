export class ExportService {
  jobs = new Map();
  keys = new Map();
  nextId = 1;

  submit(actor, key, filter) {
    if (!actor) throw new Error('forbidden');
    if (!key || typeof filter !== 'string' || !filter.trim()) throw new Error('invalid-request');
    const identity = JSON.stringify([actor, key]);
    const previousId = this.keys.get(identity);
    if (previousId) {
      const previous = this.jobs.get(previousId);
      if (previous.filter !== filter) throw new Error('idempotency-conflict');
      return { ...previous };
    }
    const job = { id: `export-${this.nextId++}`, owner: actor, filter, state: 'QUEUED', attempt: 1, result: null, reason: null, published: 0 };
    this.jobs.set(job.id, job);
    this.keys.set(identity, job.id);
    return { ...job };
  }

  dispatch(id, event, { actor, attempt, result, reason } = {}) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('not-found');
    if (['CANCEL', 'RETRY', 'DOWNLOAD'].includes(event) && actor !== job.owner) throw new Error('forbidden');
    if (['START', 'COMPLETE', 'FAIL'].includes(event) && attempt !== job.attempt) return { ...job };
    switch (event) {
      case 'START':
        if (job.state === 'RUNNING') break;
        if (job.state !== 'QUEUED') throw new Error('invalid-state');
        job.state = 'RUNNING';
        break;
      case 'COMPLETE':
        if (['SUCCEEDED', 'CANCELLED'].includes(job.state)) break;
        if (job.state !== 'RUNNING') throw new Error('invalid-state');
        if (typeof result !== 'string' || !result) throw new Error('invalid-result');
        job.state = 'SUCCEEDED';
        job.result = result;
        job.published += 1;
        break;
      case 'FAIL':
        if (['FAILED', 'SUCCEEDED', 'CANCELLED'].includes(job.state)) break;
        if (job.state !== 'RUNNING') throw new Error('invalid-state');
        if (typeof reason !== 'string' || !reason) throw new Error('invalid-reason');
        job.state = 'FAILED';
        job.reason = reason;
        break;
      case 'CANCEL':
        if (job.state === 'CANCELLED') break;
        if (!['QUEUED', 'RUNNING'].includes(job.state)) throw new Error('invalid-state');
        job.state = 'CANCELLED';
        break;
      case 'RETRY':
        if (job.state !== 'FAILED') throw new Error('invalid-state');
        job.state = 'QUEUED';
        job.attempt += 1;
        job.reason = null;
        break;
      case 'DOWNLOAD':
        if (job.state !== 'SUCCEEDED') throw new Error('not-ready');
        return job.result;
      default:
        throw new Error('invalid-event');
    }
    return { ...job };
  }
}
