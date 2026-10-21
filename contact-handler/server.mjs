import http from 'node:http';
import {createHmac, randomInt} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createChallenge, verifySolution} from 'altcha-lib';
import {deriveKey} from 'altcha-lib/algorithms/pbkdf2';
import nodemailer from 'nodemailer';

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const MAX_BODY = 32768;
class RequestError extends Error { constructor(status, code) { super(code); this.status = status; } }
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, 'invalid_input');
  const clean = {};
  for (const [key, max, required] of [['name',120,true],['email',254,true],['organisation',160,false],['message',5000,true],['source',250,false],['website',250,false],['token',8192,true]]) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new RequestError(400, 'invalid_input');
    if ((key === 'message' ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) throw new RequestError(400, 'invalid_input');
    clean[key] = value.trim();
  }
  if (!EMAIL.test(clean.email) || clean.website) throw new RequestError(400, 'invalid_input');
  return clean;
}
async function readJSON(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new RequestError(415, 'content_type');
  if (Number(req.headers['content-length']) > MAX_BODY) throw new RequestError(413, 'too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RequestError(413, 'too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'invalid_input'); }
}
function mailMessage(input, config) {
  return {
    from: {name:'Clifton Dynamics website', address:config.PROTON_SMTP_USER},
    to: config.CONTACT_RECIPIENT, replyTo: {address:input.email}, subject:'New website enquiry',
    text:[`Name: ${input.name}`,`Email: ${input.email}`,`Organisation: ${input.organisation || '(not supplied)'}`,'','What would you like to make?',input.message,'','How did you hear about Clifton Dynamics?',input.source || '(not supplied)'].join('\n'),
    disableFileAccess:true, disableUrlAccess:true
  };
}
export function createService({config = process.env, databasePath, sendMail, now = Date.now, challengeCounter} = {}) {
  if (!config.CHALLENGE_SECRET || config.CHALLENGE_SECRET.length < 32) throw new Error('A private CHALLENGE_SECRET is required');
  const allowed = (config.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  const db = new DatabaseSync(databasePath || config.DATABASE_PATH || 'contact.sqlite');
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS challenges(signature TEXT PRIMARY KEY, challenge TEXT NOT NULL, origin TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const mailReady = () => Boolean(config.PROTON_SMTP_TOKEN && EMAIL.test(config.PROTON_SMTP_USER || '') && EMAIL.test(config.CONTACT_RECIPIENT || ''));
  const transport = sendMail ? null : nodemailer.createTransport({
    host:'smtp.protonmail.ch',port:587,secure:false,requireTLS:true,
    auth:{user:config.PROTON_SMTP_USER,pass:config.PROTON_SMTP_TOKEN},
    tls:{minVersion:'TLSv1.2',rejectUnauthorized:true,servername:'smtp.protonmail.ch'},
    connectionTimeout:7000,greetingTimeout:7000,socketTimeout:10000,logger:false,debug:false
  });
  const deliver = sendMail || (async message => {
    const result = await transport.sendMail(message);
    if (!result.accepted?.length || result.rejected?.length) throw new Error('Delivery not accepted');
  });
  const digest = value => createHmac('sha256',config.CHALLENGE_SECRET).update(value).digest('hex');
  const limit = (key, maximum, seconds) => {
    const time = now();
    const bucket = `${key}:${Math.floor(time / (seconds * 1000))}`;
    const row = db.prepare('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').get(bucket,time + seconds*1000);
    return row.count <= maximum;
  };
  let cleanupAfter = 0;
  const server = http.createServer({requestTimeout:15000,headersTimeout:10000,maxHeaderSize:8192}, async (req,res) => {
    const origin = req.headers.origin;
    const headers = {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
    if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (status,body) => { if (!res.destroyed) { res.writeHead(status,headers); res.end(JSON.stringify(body)); } };
    try {
      const path = new URL(req.url,'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return reply(200,{status:mailReady() ? 'ready' : 'awaiting_mail_configuration'});
      if (!['/challenge','/enquiry'].includes(path)) return reply(404,{ok:false,code:'not_found'});
      if (!allowed.includes(origin)) return reply(403,{ok:false,code:'origin'});
      if (req.method === 'OPTIONS') {
        res.writeHead(204,{...headers,'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'}); return res.end();
      }
      // Loopback-only listener. Only a configured local HTTPS proxy may supply X-Real-IP.
      const peer = req.socket.remoteAddress;
      const ip = config.TRUST_LOCAL_PROXY === 'true' && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) ? (req.headers['x-real-ip'] || peer) : peer;
      const clientKey = digest(String(ip));
      if (now() > cleanupAfter) {
        db.prepare('DELETE FROM challenges WHERE expires < ?').run(now());
        db.prepare('DELETE FROM limits WHERE expires < ?').run(now());
        cleanupAfter = now() + 60000;
      }
      if (!limit(`requests:${clientKey}`,30,60) || !limit('requests:global',120,60)) throw new RequestError(429,'rate_limit');
      if (path === '/challenge' && req.method === 'GET') {
        const challenge = await createChallenge({algorithm:'PBKDF2/SHA-256',cost:1000,counter:challengeCounter ?? randomInt(80,200),deriveKey,hmacSignatureSecret:config.CHALLENGE_SECRET,expiresAt:new Date(now()+600000)});
        db.prepare('INSERT INTO challenges(signature,challenge,origin,expires) VALUES(?,?,?,?)').run(challenge.signature,JSON.stringify(challenge),origin,now()+600000);
        return reply(200,challenge);
      }
      if (path !== '/enquiry' || req.method !== 'POST') throw new RequestError(405,'method');
      if (!mailReady()) throw new RequestError(503,'not_configured');
      if (!limit(`send:${clientKey}`,5,600)) throw new RequestError(429,'rate_limit');
      const input = validate(await readJSON(req));
      let payload;
      try { payload = JSON.parse(Buffer.from(input.token,'base64').toString('utf8')); } catch { throw new RequestError(403,'verification'); }
      const signature = payload?.challenge?.signature;
      if (typeof signature !== 'string' || signature.length > 256) throw new RequestError(403,'verification');
      const stored = db.prepare('SELECT * FROM challenges WHERE signature=?').get(signature);
      if (!stored || stored.used || stored.expires <= now() || stored.origin !== origin) throw new RequestError(403,'verification');
      // Verify against the server's original challenge so untrusted cost/algorithm parameters never run.
      let verification;
      try { verification = await verifySolution({challenge:JSON.parse(stored.challenge),solution:payload.solution,deriveKey,hmacSignatureSecret:config.CHALLENGE_SECRET}); }
      catch { throw new RequestError(403,'verification'); }
      if (!verification.verified) throw new RequestError(403,'verification');
      // The atomic update prevents parallel replays, and persists across service restarts.
      if (db.prepare('UPDATE challenges SET used=1 WHERE signature=? AND used=0 AND expires>?').run(signature,now()).changes !== 1) throw new RequestError(403,'verification');
      if (!limit('mail:minute',10,60) || !limit('mail:day',100,86400)) throw new RequestError(429,'rate_limit');
      await deliver(mailMessage(input,config));
      return reply(200,{ok:true});
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 503;
      if (status === 429) headers['Retry-After'] = '60';
      // No addresses, enquiry text, credentials or SMTP diagnostics are logged or returned.
      reply(status,{ok:false,code:error instanceof RequestError ? error.message : 'unavailable'});
    }
  });
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 20;
  server.on('clientError',(_error,socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.once('close',() => { db.close(); transport?.close(); });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createService();
  server.listen(Number(process.env.PORT || 8845),'127.0.0.1',() => console.log('Contact service listening on loopback'));
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal,() => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1),12000).unref(); });
}
