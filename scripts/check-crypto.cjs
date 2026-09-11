const c = require('node:crypto');
const t = (name, fn) => { try { fn(); console.log('OK  ', name); } catch (e) { console.log('FAIL', name, '-', e.message); } };
t('chacha20-poly1305 createCipheriv', () => c.createCipheriv('chacha20-poly1305', Buffer.alloc(32), Buffer.alloc(12), { authTagLength: 16 }));
t('aes-128-gcm', () => c.createCipheriv('aes-128-gcm', Buffer.alloc(16), Buffer.alloc(12)));
t('ed25519 keypair+sign', () => { const k = c.generateKeyPairSync('ed25519'); c.sign(null, Buffer.from('x'), k.privateKey); });
t('x25519 dh', () => { const a = c.generateKeyPairSync('x25519'), b = c.generateKeyPairSync('x25519'); c.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }); });
t('hkdf sha512', () => c.hkdfSync('sha512', Buffer.alloc(32), Buffer.from('s'), Buffer.from('i'), 32));
t('ed25519 raw import', () => c.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 1)]), format: 'der', type: 'pkcs8' }));
console.log('ciphers with chacha:', c.getCiphers().filter((x) => /chacha/i.test(x)));
