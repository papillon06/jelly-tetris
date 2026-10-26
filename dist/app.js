import { Game, SHAPES } from './engine.js';
import { drawJelly, PALETTE } from './jelly.js';

const $ = id => document.getElementById(id);
const canvas = $('game-canvas'), ctx = canvas.getContext('2d');
const nextCtx = $('next-canvas').getContext('2d'), mascotCtx = $('mascot').getContext('2d');
const W = 300, H = 600, C = 30;
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionQuery.matches;
motionQuery.addEventListener('change', e => reducedMotion = e.matches);
const readSaved = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, String(value)); } catch {} };
let best = Math.max(0, Number(readSaved('jelly-drop-best', 0)) || 0);
let sound = readSaved('jelly-drop-sound', 'true') !== 'false';
let audioCtx, lastSound = 0, lastFrame = 0, clock = 0, clearFreeze = 0;
let activeVisual = { id: -1, x: 0, y: 0, vx: 0, vy: 0, squish: 0, tilt: 0 };
let bodyMotion = new Map(), particles = [], flashes = [], trails = [], scoreShown = -1;
let toastTimer, helpWasPlaying = false;
const game = new Game({onEvent: onGameEvent});

function unlockAudio() {
  if (!sound) return;
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); } catch {}
}
function tone(freq, duration = .1, volume = .035, delay = 0, endFreq = freq * .6) {
  if (!sound || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const t = audioCtx.currentTime + delay, osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(freq, t); osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + duration);
    gain.gain.setValueAtTime(.0001, t); gain.gain.exponentialRampToValueAtTime(volume, t + .008); gain.gain.exponentialRampToValueAtTime(.0001, t + duration);
    osc.connect(gain); gain.connect(audioCtx.destination); osc.start(t); osc.stop(t + duration + .02);
  } catch {}
}
function syncSound() {
  $('sound-btn').setAttribute('aria-label', sound ? '关闭音效' : '开启音效');
  $('sound-btn').setAttribute('aria-pressed', String(sound));
  $('sound-btn').querySelector('use').setAttribute('href', sound ? '#icon-sound' : '#icon-mute');
}
function syncUI() {
  if (game.score !== scoreShown) {
    $('score').textContent = String(game.score).padStart(6, '0'); scoreShown = game.score;
    if (game.score > best) { best = game.score; save('jelly-drop-best', best); }
    $('best-score').textContent = best.toLocaleString('zh-CN');
  }
  $('lines').textContent = game.lines;
  $('level').textContent = String(game.level).padStart(2, '0');
  $('level-progress').style.width = `${(game.lines % 10) * 10}%`;
  $('progress-caption').textContent = `再消除 ${10 - game.lines % 10} 行，升一级`;
}
function stateUI(state) {
  const visible = state !== 'playing';
  $('game-overlay').classList.toggle('hidden', !visible);
  $('pause-btn').disabled = state === 'idle' || state === 'over';
  $('restart-btn').disabled = state === 'idle';
  $('pause-btn').setAttribute('aria-label', state === 'paused' ? '继续游戏' : '暂停游戏');
  $('pause-btn').querySelector('use').setAttribute('href', state === 'paused' ? '#icon-play' : '#icon-pause');
  $('status-label').textContent = {idle:'准备好，弹起来',playing:'享受每一次落下',paused:'休息一下也很棒',over:'再来一局也不错'}[state];
  if (state === 'paused') {
    $('overlay-kicker').textContent = 'TAKE A LITTLE BREATH';
    $('overlay-title').textContent = '快乐，暂停一下';
    $('overlay-description').textContent = '小果冻会在这里乖乖等你。';
    $('start-btn').querySelector('span').textContent = '继续游戏';
    $('overlay-hint').textContent = '按 P 或 Enter 继续';
    $('overlay-mark').querySelector('use').setAttribute('href', '#icon-pause');
  } else if (state === 'over') {
    $('overlay-kicker').textContent = 'THAT WAS A SWEET RUN';
    $('overlay-title').textContent = '装满快乐啦！';
    $('overlay-description').textContent = `本局 ${game.score} 分 · 消除了 ${game.lines} 行`;
    $('start-btn').querySelector('span').textContent = '再来一局';
    $('overlay-hint').textContent = '按 Enter，开启新的一局';
    $('overlay-mark').querySelector('use').setAttribute('href', '#icon-reset');
    $('announcer').textContent = `游戏结束，得分 ${game.score}，消除了 ${game.lines} 行。`;
  }
  if (state !== 'playing') releaseAll();
}
function bodyKey(cell) { return `${cell.id}:${cell.x}:${cell.y}`; }
function freshMotion() { return { x:0, y:0, vx:0, vy:0, squash:0, vs:0, tilt:0, vt:0, flight:0, elapsed:0, startY:0, impact:0 }; }
function onGameEvent(e) {
  if (e.type === 'state') { stateUI(e.state); return; }
  if (e.type === 'spawn') {
    activeVisual = {id:e.piece.id,x:e.piece.x,y:e.piece.y - .2,vx:0,vy:0,squish:0,tilt:0};
    drawNext();
  }
  if (e.type === 'move' && !e.hardDrop) {
    activeVisual.tilt += e.dx * .045;
    if (e.dx && clock - lastSound > 65) { tone(230,.045,.014,0,200); lastSound = clock; }
  }
  if (e.type === 'rotate') { activeVisual.squish = -.16; activeVisual.tilt = e.dir * .14; tone(380,.075,.02,0,540); }
  if (e.type === 'land') {
    const flight = e.hardDrop && e.distance > 2 && !reducedMotion ? Math.min(145, 65 + e.distance * 4) : 0;
    for (const cell of e.cells) {
      const body = freshMotion();
      body.impact = e.impact;
      body.x = reducedMotion ? 0 : (activeVisual.x - game.active.x) * C;
      body.vx = reducedMotion ? 0 : e.dx * 60;
      body.tilt = reducedMotion ? 0 : e.dx * .14;
      body.squash = reducedMotion ? 0 : .48 * e.impact;
      if (flight) { body.flight = flight; body.startY = (activeVisual.y - game.active.y) * C; body.y = body.startY; body.squash = -.15; }
      bodyMotion.set(bodyKey(cell),body);
    }
    if (flight) trails.push({cells:e.cells,from:activeVisual.y - game.active.y,life:.17,max:.17});
    if (!reducedMotion) {
      const maxY = Math.max(...e.cells.map(c=>c.y));
      for (const [key,b] of bodyMotion) { if (!e.cells.some(c=>bodyKey(c)===key)) { const row = Number(key.split(':')[2]); if(Math.abs(row-maxY)<3) b.vs += .8*e.impact; } }
    }
    tone(155,.17,.045,flight/1000,72);tone(290,.09,.015,flight/1000+.05,190);
  }
  if (e.type === 'clear') {
    clearFreeze = 190;
    flashes.push(...e.rows.map(row=>({row,life:.36,max:.36})));
    for (const cell of e.cells) for (let i=0;i<(reducedMotion?2:7);i++) {
      particles.push({x:(cell.x+.5)*C,y:(cell.y+.5)*C,vx:(Math.random()-.5)*155,vy:-45-Math.random()*125,r:2+Math.random()*5,type:cell.type,life:.5+Math.random()*.4,max:.9});
    }
    const shifted = new Map();
    for (const [key,b] of bodyMotion) {
      const [id,x,y] = key.split(':').map(Number);
      if (e.rows.includes(y)) continue;
      const fall = e.rows.filter(row=>row>y).length;
      b.y -= reducedMotion ? 0 : fall*C; b.flight=0; b.vy=0;
      shifted.set(`${id}:${x}:${y+fall}`,b);
    }
    bodyMotion = shifted;
    const labels=['','啵！消掉一行','DOUBLE POP!','TRIPLE POP!','JELLY PARTY!'];
    $('clear-toast').textContent = `${labels[e.count]}  +${e.points}`;
    $('clear-toast').classList.remove('show'); void $('clear-toast').offsetWidth; $('clear-toast').classList.add('show');
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('clear-toast').classList.remove('show'),1400);
    $('announcer').textContent = `消除 ${e.count} 行，加 ${e.points} 分。`;
    $('board-hint').textContent = e.combo > 1 ? `${e.combo} 连击！快乐正在加倍` : '啵！烦恼又少了一点';
    [440,554,659,880].slice(0,Math.min(4,e.count+1)).forEach((f,i)=>tone(f,.19,.028,i*.07,f*1.15));
  }
}
function startOrResume() {
  unlockAudio();
  if (game.state === 'paused') game.togglePause();
  else if (game.state !== 'playing') startGame();
  canvas.focus({preventScroll:true});
}
function startGame() {
  bodyMotion.clear();particles=[];flashes=[];trails=[];clearFreeze=0;
  $('board-hint').textContent='每一块，都有一点小脾气';
  $('clear-toast').classList.remove('show');
  game.start();syncUI();tone(330,.12,.03);tone(495,.15,.025,.09,660);
}
$('start-btn').addEventListener('click',startOrResume);
$('pause-btn').addEventListener('click',()=>{unlockAudio();game.togglePause();canvas.focus({preventScroll:true});});
$('restart-btn').addEventListener('click',()=>{unlockAudio();startGame();canvas.focus({preventScroll:true});});
$('sound-btn').addEventListener('click',()=>{sound=!sound;save('jelly-drop-sound',sound);syncSound();unlockAudio();if(sound)tone(440,.1,.025);});
function closeHelp() { $('help-dialog').close(); if(helpWasPlaying && game.state==='paused')game.togglePause();helpWasPlaying=false; }
$('help-btn').addEventListener('click',()=>{helpWasPlaying=game.state==='playing';if(helpWasPlaying)game.togglePause();$('help-dialog').showModal();});
$('close-help').addEventListener('click',closeHelp);$('got-it').addEventListener('click',closeHelp);
$('help-dialog').addEventListener('cancel',e=>{e.preventDefault();closeHelp();});

const keyActions={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'rotate',ArrowDown:'down',' ':'drop',a:'left',d:'right',w:'rotate',s:'down',x:'rotate',z:'backrotate'};
const heldKeys = new Map(), heldTouches = new Map();
function action(name) { if(game.state!=='playing'||clearFreeze>0)return; if(name==='left')game.move(-1);if(name==='right')game.move(1);if(name==='rotate')game.rotate(1);if(name==='backrotate')game.rotate(-1);if(name==='down')game.softDrop();if(name==='drop')game.hardDrop();syncUI(); }
function releaseAll() { heldKeys.clear();heldTouches.clear();document.querySelectorAll('.held').forEach(el=>el.classList.remove('held')); }
window.addEventListener('keydown',e=>{
  if($('help-dialog').open)return;
  const key=e.key.length===1?e.key.toLowerCase():e.key;
  if(key==='p'||key==='Escape'){if(game.state==='playing'||game.state==='paused'){e.preventDefault();if(!e.repeat)game.togglePause();}return;}
  if(key==='Enter'&&game.state!=='playing'){if(e.target.tagName==='BUTTON')return;e.preventDefault();startOrResume();return;}
  const act=keyActions[key];if(!act||game.state!=='playing')return;
  if(key===' '&&e.target.tagName==='BUTTON')return;
  e.preventDefault();if(e.repeat)return;unlockAudio();action(act);
  if(['left','right','down'].includes(act))heldKeys.set(key,{act,elapsed:0,next:act==='down'?55:170});
});
window.addEventListener('keyup',e=>heldKeys.delete(e.key.length===1?e.key.toLowerCase():e.key));
window.addEventListener('blur',()=>{releaseAll();if(game.state==='playing')game.togglePause();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){releaseAll();if(game.state==='playing')game.togglePause();}});
for(const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('pointerdown',e=>{e.preventDefault();unlockAudio();button.setPointerCapture(e.pointerId);button.classList.add('held');action(button.dataset.action);if(['left','right','down'].includes(button.dataset.action))heldTouches.set(e.pointerId,{act:button.dataset.action,elapsed:0,next:170});});
  const up=e=>{button.classList.remove('held');heldTouches.delete(e.pointerId);};
  button.addEventListener('pointerup',up);button.addEventListener('pointercancel',up);button.addEventListener('lostpointercapture',up);
  button.addEventListener('click',e=>{if(e.detail===0){unlockAudio();action(button.dataset.action);}});
}
let gesture=null;
canvas.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'||game.state!=='playing')return;unlockAudio();canvas.setPointerCapture(e.pointerId);gesture={x:e.clientX,y:e.clientY,lastX:e.clientX,t:performance.now(),moved:false,id:e.pointerId};});
canvas.addEventListener('pointermove',e=>{if(!gesture||gesture.id!==e.pointerId)return;const threshold=canvas.getBoundingClientRect().width/10;while(Math.abs(e.clientX-gesture.lastX)>threshold){const dir=Math.sign(e.clientX-gesture.lastX);action(dir>0?'right':'left');gesture.lastX+=dir*threshold;gesture.moved=true;}});
canvas.addEventListener('pointerup',e=>{if(!gesture||gesture.id!==e.pointerId)return;const dy=e.clientY-gesture.y,dx=e.clientX-gesture.x;if(dy>45&&Math.abs(dx)<60)action(performance.now()-gesture.t<500?'drop':'down');else if(!gesture.moved&&Math.abs(dy)<15)action('rotate');gesture=null;});
canvas.addEventListener('pointercancel',()=>gesture=null);

function fitCanvas(element,context,width,height) {
  const dpr=Math.min(window.devicePixelRatio||1,2);
  element.width=Math.round(width*dpr);element.height=Math.round(height*dpr);context.setTransform(dpr,0,0,dpr,0,0);
}
function resize(){fitCanvas(canvas,ctx,W,H);fitCanvas($('next-canvas'),nextCtx,250,80);fitCanvas($('mascot'),mascotCtx,300,240);drawNext();}
function drawNext(){
  nextCtx.clearRect(0,0,250,80);
  const types=game.next.length?game.next.slice(0,3):['T','S','L'];
  types.forEach((type,i)=>{const matrix=SHAPES[type];const cells=[];matrix.forEach((row,y)=>row.forEach((v,x)=>{if(v)cells.push({x,y});}));const minX=Math.min(...cells.map(c=>c.x)),maxX=Math.max(...cells.map(c=>c.x)),minY=Math.min(...cells.map(c=>c.y)),maxY=Math.max(...cells.map(c=>c.y));const size=i===0?20:17;const center=41+i*83;cells.forEach((c,n)=>drawJelly(nextCtx,center-(maxX-minX+1)*size/2+(c.x-minX)*size,40-(maxY-minY+1)*size/2+(c.y-minY)*size,size,type,{face:i===0&&n===2,alpha:i===0?1:.72}));if(i<2){nextCtx.fillStyle='#a9b59b';nextCtx.beginPath();nextCtx.arc(82+i*83,40,1,0,Math.PI*2);nextCtx.fill();}});
}
const demoRows=[
  [null,null,null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null,'L',null],
  [null,'T',null,null,null,null,null,'L','L','L'],
  ['T','T','T',null,null,null,'S','S','J','J'],
  ['I','I','I','I',null,'S','S','O','O','J'],
  ['Z','Z','O','O','T','T','T','O','O','J'],
];
function drawGrid(){
  ctx.clearRect(0,0,W,H);ctx.fillStyle='#f5f8f1';ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#d7e1d349';ctx.lineWidth=.65;ctx.beginPath();for(let x=1;x<10;x++){ctx.moveTo(x*C,0);ctx.lineTo(x*C,H);}for(let y=1;y<20;y++){ctx.moveTo(0,y*C);ctx.lineTo(W,y*C);}ctx.stroke();
  ctx.fillStyle='#b8c9ac50';for(let y=1;y<20;y++)for(let x=1;x<10;x++){ctx.beginPath();ctx.arc(x*C,y*C,.8,0,Math.PI*2);ctx.fill();}
}
function springBody(b,dt){
  if(reducedMotion){b.x=b.y=b.squash=b.tilt=0;return;}
  if(b.flight){b.elapsed+=dt*1000;const p=Math.min(1,b.elapsed/b.flight);b.y=b.startY*(1-p*p);if(p>=1){b.flight=0;b.y=0;b.vy=-55*b.impact;b.squash=.5*b.impact;b.vs=1.8;}else return;}
  b.vx+=(-165*b.x-14*b.vx)*dt;b.x+=b.vx*dt;
  b.vy+=(-160*b.y-13*b.vy)*dt;b.y+=b.vy*dt;
  b.vs+=(-165*b.squash-10*b.vs)*dt;b.squash+=b.vs*dt;
  b.vt+=(-140*b.tilt-9*b.vt)*dt;b.tilt+=b.vt*dt;
}
function drawBoard(dt){
  drawGrid();ctx.save();ctx.beginPath();ctx.roundRect(0,0,W,H,14);ctx.clip();
  if(game.state==='idle'){
    demoRows.forEach((row,ry)=>row.forEach((type,x)=>{if(!type)return;const bob=reducedMotion?0:Math.sin(clock*.0019+x*.7+ry*.4)*.035;drawJelly(ctx,x*C,(ry+14)*C,C,type,{squash:bob,face:(ry+x)%5===0,time:clock});}));
    const floatCells=[{x:2,y:4,type:'O'},{x:3,y:4,type:'O'},{x:2,y:5,type:'O'},{x:3,y:5,type:'O'}];
    floatCells.forEach((c,i)=>drawJelly(ctx,c.x*C,c.y*C+(reducedMotion?0:Math.sin(clock*.0016)*7),C,c.type,{face:i===3,tilt:.02,squash:.04}));
  } else {
    if(game.active&&game.state!=='over'){
      const ghost={...game.active,y:game.ghostY()};
      game.getCells(ghost).forEach(c=>drawJelly(ctx,c.x*C,c.y*C,C,c.type,{ghost:true}));
    }
    for(const trail of trails){ctx.globalAlpha=trail.life/trail.max*.1;for(const c of trail.cells){const grad=ctx.createLinearGradient(0,(c.y+trail.from)*C,0,(c.y+1)*C);grad.addColorStop(0,'#a7c9c000');grad.addColorStop(1,PALETTE[c.type].base);ctx.fillStyle=grad;ctx.fillRect(c.x*C+5,Math.max(0,(c.y+trail.from)*C),C-10,-trail.from*C);}ctx.globalAlpha=1;}
    const faceIds=new Set();
    game.board.forEach((row,y)=>row.forEach((cell,x)=>{if(!cell)return;const b=bodyMotion.get(bodyKey({...cell,x,y}));if(b)springBody(b,dt);const face=!faceIds.has(cell.id)&&cell.id%3!==0;faceIds.add(cell.id);drawJelly(ctx,x*C+(b?.x||0),y*C+(b?.y||0),C,cell.type,{squash:b?.squash||0,tilt:b?.tilt||0,face,time:clock});}));
    if(game.active){
      const a=game.active,v=activeVisual;
      if(reducedMotion){v.x=a.x;v.y=a.y;v.squish=0;v.tilt=0;}else{
        const xPull=(a.x-v.x)*400-26*v.vx;v.vx+=xPull*dt;v.x+=v.vx*dt;
        const yPull=(a.y-v.y)*360-25*v.vy;v.vy+=yPull*dt;v.y+=v.vy*dt;
        v.squish*=Math.exp(-9*dt);v.tilt*=Math.exp(-9*dt);
      }
      game.getCells().forEach((c,i)=>drawJelly(ctx,(c.x+v.x-a.x)*C,(c.y+v.y-a.y)*C,C,c.type,{face:i===1,squash:v.squish-Math.min(.11,Math.abs(v.vy)*.012),tilt:v.tilt+v.vx*.005,time:clock}));
    }
  }
  for(const f of flashes){ctx.globalAlpha=f.life/f.max*.65;const grad=ctx.createLinearGradient(0,0,W,0);grad.addColorStop(0,'#eaffce00');grad.addColorStop(.5,'#ffffff');grad.addColorStop(1,'#eaffce00');ctx.fillStyle=grad;ctx.fillRect(0,f.row*C,W,C);ctx.globalAlpha=1;}
  for(const p of particles){ctx.globalAlpha=Math.max(0,p.life/p.max);ctx.fillStyle=PALETTE[p.type].light;ctx.strokeStyle=PALETTE[p.type].base;ctx.lineWidth=1;ctx.beginPath();ctx.arc(p.x,p.y,Math.max(.1,p.r*p.life/p.max),0,Math.PI*2);ctx.fill();ctx.stroke();}ctx.globalAlpha=1;ctx.restore();
}
function drawMascot(){
  const c=mascotCtx;c.clearRect(0,0,300,240);const t=reducedMotion?0:clock*.001;
  c.save();c.translate(153,183);c.scale(1,.22);const shadow=c.createRadialGradient(0,0,5,0,0,100);shadow.addColorStop(0,'#53614526');shadow.addColorStop(1,'#53614500');c.fillStyle=shadow;c.beginPath();c.arc(0,0,100,0,7);c.fill();c.restore();
  c.save();c.translate(43,102+Math.sin(t*1.4)*3);c.rotate(-.16);drawJelly(c,0,0,87,'T',{face:true,squash:.08+Math.sin(t*1.6)*.045,tilt:-.035,time:clock});c.restore();
  c.save();c.translate(179,104+Math.sin(t*1.8+2)*3);c.rotate(.17);drawJelly(c,0,0,79,'O',{face:true,squash:.05+Math.sin(t*1.8)*.05,time:clock});c.restore();
  c.save();c.translate(107,52+Math.sin(t*1.6+1)*5);c.rotate(.055);drawJelly(c,0,0,94,'S',{face:true,squash:Math.sin(t*1.4)*.05,tilt:.03,time:clock});c.restore();
  c.strokeStyle='#a5b696';c.lineWidth=1.1;[[238,67,5],[55,61,3]].forEach(([x,y,r])=>{c.beginPath();c.moveTo(x-r,y);c.lineTo(x+r,y);c.moveTo(x,y-r);c.lineTo(x,y+r);c.stroke();});c.fillStyle='#c8d4b7';c.beginPath();c.arc(32,137,2,0,7);c.fill();
}
function frame(now){
  const dt=Math.min((now-lastFrame)/1000||.016,.033);lastFrame=now;clock+=dt*1000;
  if(clearFreeze>0)clearFreeze-=dt*1000;else game.update(dt*1000);
  for(const held of [...heldKeys.values(),...heldTouches.values()]){held.elapsed+=dt*1000;if(held.elapsed>=held.next){action(held.act);held.next+=held.act==='down'?45:75;}}
  particles=particles.filter(p=>{p.life-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=210*dt;return p.life>0;});
  flashes=flashes.filter(f=>(f.life-=dt)>0);trails=trails.filter(t=>(t.life-=dt)>0);
  drawBoard(dt);if(window.innerWidth>900)drawMascot();syncUI();requestAnimationFrame(frame);
}
resize();window.addEventListener('resize',resize);syncSound();syncUI();requestAnimationFrame(frame);
// Read-only diagnostics allow rule/renderer checks without changing the live board.
window.jellyDiagnostics = () => ({state:game.state,score:game.score,lines:game.lines,level:game.level,active:game.active?{type:game.active.type,x:game.active.x,y:game.active.y}:null,occupied:game.board.flat().filter(Boolean).length,movingBodies:[...bodyMotion.values()].filter(b=>Math.abs(b.squash)>.01||Math.abs(b.x)>.1||Math.abs(b.y)>.1).length});
