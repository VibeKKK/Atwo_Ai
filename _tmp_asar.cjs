
const fs=require('fs');
const P='D:\\code app\\ai code\\WorkBuddy\\resources\\app.asar';
const fd=fs.openSync(P,'r');
const b=Buffer.alloc(16); fs.readSync(fd,b,0,16,0);
const jsonLen=b.readUInt32LE(12);
const hb=Buffer.alloc(jsonLen); fs.readSync(fd,hb,0,jsonLen,16);
const H=JSON.parse(hb.toString('utf8'));
function node(p){ let n=H; for(const seg of p.split('/')){ if(!n||!n.files) return null; n=n.files[seg]; if(!n) return null; } return n; }
const d=node('cli/dist');
console.log('cli/dist:', d&&d.files? Object.keys(d.files).slice(0,40).join(', '):'none');
const d2=node('cli/dist/lazy-lite-wb');
console.log('lazy-lite-wb:', d2&&d2.files? Object.keys(d2.files).slice(0,20).join(', '):'none');
