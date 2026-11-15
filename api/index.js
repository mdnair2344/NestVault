process.env.NESTVAULT_SERVERLESS = '1';
const app = require('../server.js');
module.exports = (req, res) => app.handle(req, res);