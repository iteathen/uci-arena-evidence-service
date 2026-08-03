import { acquirePruneLock } from "./prune_lock.mjs";
import { PruneService } from "./prune_service.mjs";

export class PruneOperation {
  constructor(
    store,
    config,
    {
      lockFactory = acquirePruneLock,
      workflow = null,
      workflowOptions = {},
    } = {},
  ) {
    if (typeof lockFactory !== "function") {
      throw new Error("PruneOperation requires a lock factory");
    }
    this.config = config;
    this.lockFactory = lockFactory;
    this.workflow = workflow ?? new PruneService(store, config, workflowOptions);
  }

  async run(input) {
    const release = await this.lockFactory(this.config.paths.locks);
    let result;
    let operationError = null;
    try {
      result = await this.workflow.run(input);
    } catch (error) {
      operationError = error;
    }

    let releaseError = null;
    try {
      await release();
    } catch (error) {
      releaseError = error;
    }
    if (operationError && releaseError) {
      throw new AggregateError(
        [operationError, releaseError],
        "Evidence prune operation and lock release both failed",
      );
    }
    if (operationError) throw operationError;
    if (releaseError) throw releaseError;
    return result;
  }
}
