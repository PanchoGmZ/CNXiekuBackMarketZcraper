import { Actor, log } from 'apify';

import { runActor } from './run.js';

// Also use `apify run --no-purge` to prevent CLI cleanup of existing storage.
Actor.config.set('purgeOnStart', false);
// Our abort handler persists RUN_STATE before exiting.
await Actor.init({ gracefulShutdown: false });

try {
    const outcome = await runActor();
    if (outcome === 'completed') await Actor.exit();
} catch (error) {
    log.exception(error as Error, 'Actor run failed.');
    await Actor.exit({ exitCode: 1 });
}
