import { PruneService } from "./prune_service.mjs";

function uniqueErrors(values) {
  const result = [];
  for (const value of values) {
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

export class PruneOperation {
  constructor(
    store,
    config,
    {
      leaseFactory = () => store.acquireOperationLease(),
      workflow = null,
      workflowOptions = {},
      heartbeatIntervalMs = 5_000,
      setIntervalImpl = setInterval,
      clearIntervalImpl = clearInterval,
    } = {},
  ) {
    if (typeof leaseFactory !== "function") {
      throw new Error("PruneOperation requires a lease factory");
    }
    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 100) {
      throw new Error("PruneOperation heartbeat interval must be at least 100 ms");
    }
    if (typeof setIntervalImpl !== "function" || typeof clearIntervalImpl !== "function") {
      throw new Error("PruneOperation timer dependencies are invalid");
    }
    this.leaseFactory = leaseFactory;
    this.workflow = workflow ?? new PruneService(store, config, workflowOptions);
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
  }

  async run(input) {
    const lease = await this.leaseFactory();
    if (!lease
        || typeof lease.heartbeat !== "function"
        || typeof lease.release !== "function") {
      let cleanupError = null;
      try {
        lease?.release?.();
      } catch (error) {
        cleanupError = error;
      }
      const contractError = new Error("Evidence prune lease factory returned an invalid lease");
      if (cleanupError) {
        throw new AggregateError(
          [contractError, cleanupError],
          "Evidence prune lease contract and cleanup both failed",
        );
      }
      throw contractError;
    }

    let heartbeatError = null;
    const heartbeat = () => {
      if (heartbeatError) throw heartbeatError;
      try {
        lease.heartbeat();
      } catch (error) {
        heartbeatError = error;
        throw error;
      }
    };

    let result;
    let operationError = null;
    let timer = null;
    try {
      heartbeat();
      timer = this.setIntervalImpl(() => {
        try {
          lease.heartbeat();
        } catch (error) {
          heartbeatError ??= error;
        }
      }, this.heartbeatIntervalMs);
      timer?.unref?.();
      result = await this.workflow.run({ ...input, heartbeat });
      heartbeat();
    } catch (error) {
      operationError = error;
    } finally {
      if (timer !== null) {
        try {
          this.clearIntervalImpl(timer);
        } catch (error) {
          operationError ??= error;
        }
      }
    }

    let releaseError = null;
    try {
      lease.release();
    } catch (error) {
      releaseError = error;
    }
    const errors = uniqueErrors([operationError, heartbeatError, releaseError]);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Evidence prune operation or lease lifecycle failed",
      );
    }
    return result;
  }
}
