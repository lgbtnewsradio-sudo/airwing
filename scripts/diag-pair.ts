import { AirPlayClient } from '../src/main/airplay/client';
import { log } from '../src/main/logger';
log.verbose = true;
const txt = { features: '0x5A7FDFD5,0x3C175FDE', flags: '0x118644', model: 'AppleTV5,3', pi: 'c032716b-56be-41c1-ba98-f71f1f245e0d' };
(async () => {
  const c = new AirPlayClient({ host: '192.168.1.67', port: 7000, name: 'ATV', txt, senderName: 'AirWing' });
  await c.connect();
  console.log('--- authenticate (transient attempt, expected to require PIN)');
  try { await c.authenticate(); console.log('authenticate OK?!'); } catch (e) { console.log('authenticate ->', (e as Error).name, (e as Error).message); }
  c.close();
  const p = new AirPlayClient({ host: '192.168.1.67', port: 7000, name: 'ATV', txt, senderName: 'AirWing' });
  await p.connect();
  console.log('--- startPairing (TV should show a code)');
  try { await p.startPairing(); console.log('startPairing OK'); } catch (e) { console.log('startPairing ->', (e as Error).message); process.exit(1); }
  console.log('--- finishPairing with WRONG pin 0000');
  try { await p.finishPairing('0000'); console.log('finish OK?!'); } catch (e) { console.log('finish ->', (e as Error).message); }
  p.close();
  process.exit(0);
})();
