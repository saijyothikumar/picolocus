/**
 * @silent-mi/onnx - LatestOnlyQueue with queue depth 1
 * Invariant: Rapid typing supersedes queued intermediate queries, resolving them cleanly with null.
 */

export interface QueuedItem<T> {
  task: () => Promise<T>;
  resolve: (value: T | null) => void;
  reject: (reason?: any) => void;
}

export class LatestOnlyQueue<T> {
  private isRunning = false;
  private pending: QueuedItem<T> | null = null;

  /**
   * Enqueues a task. If another task is already running, this task is queued.
   * If a previous task was already queued, it is superseded and its promise resolves cleanly with null.
   */
  enqueue(task: () => Promise<T>): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      if (!this.isRunning) {
        this.isRunning = true;
        this.executeTask(task, resolve, reject);
      } else {
        // Supersede previous queued task if one exists
        if (this.pending) {
          this.pending.resolve(null);
          this.pending = null;
        }

        this.pending = { task, resolve, reject };
      }
    });
  }

  private async executeTask(
    task: () => Promise<T>,
    resolve: (value: T | null) => void,
    reject: (reason?: any) => void
  ): Promise<void> {
    try {
      const result = await task();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      if (this.pending) {
        const next = this.pending;
        this.pending = null;
        this.executeTask(next.task, next.resolve, next.reject);
      } else {
        this.isRunning = false;
      }
    }
  }

  clear(): void {
    if (this.pending) {
      this.pending.resolve(null);
      this.pending = null;
    }
  }
}
