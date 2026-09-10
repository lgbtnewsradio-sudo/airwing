const mdns = require('multicast-dns')({interface: '192.168.1.190'});
const seen = new Map();
mdns.on('response', (res, rinfo) => {
  for (const a of [...res.answers, ...res.additionals]) {
    if (a.type === 'PTR' && /_googlecast|_airplay|_raop/.test(a.name)) {
      if (!seen.has(a.data)) { seen.set(a.data, rinfo.address); console.log('PTR', a.name, '->', a.data, 'from', rinfo.address); }
    }
    if (a.type === 'TXT' && /_googlecast|_airplay/.test(a.name)) console.log('TXT', a.name, a.data.map(b=>b.toString()).filter(s=>/^(fn|md|model|deviceid|features|flags|pk|srcvers|vv|ca|rs)=/.test(s)).join(' | '));
    if (a.type === 'SRV') console.log('SRV', a.name, a.data.target, a.data.port);
  }
});
const q = () => mdns.query({questions: [
  {name: '_googlecast._tcp.local', type: 'PTR'},
  {name: '_airplay._tcp.local', type: 'PTR'},
  {name: '_raop._tcp.local', type: 'PTR'}]});
q(); setTimeout(q, 1500); setTimeout(q, 3000);
setTimeout(() => { console.log('done, devices:', seen.size); process.exit(0); }, 6000);
