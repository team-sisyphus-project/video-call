/**
 * The demo launcher and index generator run in Node, not in the browser: they
 * are build tooling, like `server/`. Without this the shared browser config
 * flags `process` and `__dirname` as undefined globals.
 */
module.exports = {
    env: {
        node: true
    }
};
