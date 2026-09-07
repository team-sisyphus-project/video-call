/**
 * The preview runner runs in Node, not in the browser: it is build and
 * deployment tooling, like `server/` and `demo/`. Without this the shared
 * browser config flags `process` and `__dirname` as undefined globals.
 */
module.exports = {
    env: {
        node: true
    }
};
