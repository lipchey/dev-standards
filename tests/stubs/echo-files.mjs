// Test stub: prints its received argv (after the script path) as JSON.
// Used for manual/integration inspection of file-token expansion. Not
// observable through runCheck, which uses stdio:'inherit'. Run as `node`.
console.log(JSON.stringify(process.argv.slice(2)));
