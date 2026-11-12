// Prints the link to give judges. Usage: npm run link -- https://your-app.onrender.com
import { config } from '../src/config.js';
import { shareToken } from '../src/access.js';

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
if (!config.accessKey) {
  console.log('ACCESS_KEY is empty. Set it in .env (or use the same value you put in Render), then run this again.');
  process.exit(1);
}
console.log(`${base}/?key=${shareToken(config.accessKey)}`);
