import { GelGame, SHAPES } from './gel-engine.js';
import { renderGel, renderGhost, PALETTE } from './gel-renderer.js';
const $=id=>document.getElementById(id), canvas=$('game-canvas'),ctx=canvas.getContext('2d'),nextCtx=$('next-canvas').getContext('2d');
const C=80,OX=40,OY=30,W=400,H=720;
const reduceQuery=matchMedia('(prefers-reduced-motion: reduce)');let reduced=reduceQuery.matches;reduceQuery.addEventListener('change',e=>reduced=e.matches);
const read=(key,fallback)=>{try{return localStorage.getItem(key)??fallback;}catch{return fallback;}};
const save=(key,v)=>{try{localStorage.setItem(key,String(v));}catch{}};
let best=Number(read('jelly-gel-best',0))||0,sound=read('jelly-drop-sound','true')!=='false',audioCtx;
let clock=0,lastTime=0,bodies=new Map(),particles=[],clearBands=[],removed=[],settles=new Map(),lastUI='',helpWasPlaying=false,toastTimer;
const held=new Map();
const game=new GelGame({onEvent:handleEvent});
function unlock(){if(!sound)return;try{audioCtx||=new(window.AudioContext||window.webkitAudioContext)();if(audioCtx.state==='suspended')audioCtx.resume().catch(()=>{});}catch{}}
function tone(f,d=.13,v=.04,delay=0,end=f*.6){if(!sound||!audioCtx||audioCtx.state!=='running')return;try{const t=audioCtx.currentTime+delay,o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='sine';o.frequency.setValueAtTime(f,t);o.frequency.exponentialRampToValueAtTime(Math.max(20,end),t+d);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(v,t+.008);g.gain.exponentialRampToValueAtTime(.0001,t+d);o.connect(g);g.connect(audioCtx.destination);o.start(t);o.stop(t+d+.02);}catch{}}
function syncSound(){$('sound-btn').setAttribute('aria-label',sound?'关闭音效':'开启音效');$('sound-btn').setAttribute('aria-pressed',String(sound));$('sound-btn').querySelector('use').setAttribute('href',sound?'#sound':'#mute');}
function syncUI(){const signature=[game.score,game.lines,game.level].join();if(signature===lastUI)return;lastUI=signature;if(game.score>best){best=game.score;save('jelly-gel-best',best);}$('score').textContent=String(game.score).padStart(4,'0');$('score-mobile').textContent=game.score;$('lines').textContent=game.lines;$('lines-mobile').textContent=game.lines;$('level').textContent=String(game.level).padStart(2,'0');$('best-score').textContent=best;$('best-mobile').textContent=best;}
function setState(state){$('game-overlay').classList.toggle('hidden',state==='playing');$('pause-btn').disabled=['idle','over'].includes(state);$('restart-btn').disabled=state==='idle';$('pause-btn').setAttribute('aria-label',state==='paused'?'继续游戏':'暂停游戏');$('pause-btn').querySelector('use').setAttribute('href',state==='paused'?'#play':'#pause');$('status-label').textContent={idle:'准备好，接住小果冻',playing:'落地还能挪一挪',paused:'让快乐歇一会儿',over:'这罐快乐，装满啦'}[state];if(state==='paused'){ $('overlay-kicker').textContent='TAKE A LITTLE BREAK';$('overlay-title').textContent='暂停一下下';$('overlay-description').textContent='小果冻会在这里等你。';$('start-btn').querySelector('span').textContent='继续游戏';$('overlay-hint').textContent='按 P 或 Enter 继续';}if(state==='over'){$('overlay-kicker').textContent='ONE MORE SQUISH?';$('overlay-title').textContent='装满快乐啦';$('overlay-description').textContent=`本局 ${game.score} 分 · 消除 ${game.lines} 行`;$('start-btn').querySelector('span').textContent='再来一局';$('overlay-hint').textContent='按 Enter 重新开始';$('announcer').textContent=`游戏结束，${game.score} 分，消除了 ${game.lines} 行。`;}if(state!=='playing')release();}
function newBody(){return {x:0,vx:0,y:0,vy:0,q:0,vq:0,bend:0,vb:0,lean:0,vl:0,impact:0,age:9};}
function getBody(id){if(!bodies.has(id))bodies.set(id,newBody());return bodies.get(id);}
function impactBody(b,power,dx){if(reduced)return;b.impact=power;b.age=0;b.y=0;b.vy=-1.4-power*.48;b.q=.45+power*.14;b.vq=.8;b.vx+=dx*(.65+power*.25);b.bend=dx*.14+(Math.random()-.5)*.065;b.vb=dx*.6;b.lean=dx*.045;}
function handleEvent(e){
  if(e.type==='state'){setState(e.state);return;}
  if(e.type==='spawn'){getBody(e.piece.id);drawNext();}
  if(e.type==='move'&&e.dx){const b=getBody(game.active.id);b.x-=e.dx;b.vx+=e.dx*.9;b.bend=-e.dx*.07;b.lean=-e.dx*.04;tone(230,.05,.016,0,185);}
  if(e.type==='rotate'){const b=getBody(game.active.id);b.q=-.15;b.bend=e.dir*.1;b.lean=e.dir*.09;b.x-=e.dx;tone(370,.09,.025,0,510);}
  if(e.type==='drop')tone(350,.15,.018,0,90);
  if(e.type==='contact'){
    impactBody(getBody(e.cells[0].id),e.impact,e.dx);tone(135,.2,.06,0,53);tone(285,.12,.017,.065,190);
    const landedIds=new Set(e.cells.map(c=>c.id));const bottom=Math.max(...e.cells.map(c=>c.y));
    for(const [id,b]of bodies)if(!landedIds.has(id)){b.vq+=.7*e.impact;b.vb+=e.dx*.25;b.age=Math.min(b.age,.1);}
    if(!reduced)for(let i=0;i<8;i++)particles.push({x:OX+(e.cells.reduce((a,c)=>a+c.x,0)/e.cells.length+.5)*C,y:OY+(bottom+1)*C,vx:(Math.random()-.5)*125,vy:-20-Math.random()*35,r:1.5+Math.random()*2,color:'#ffffff',life:.3,max:.3});
  }
  if(e.type==='clear'){
    for(const row of e.rows)clearBands.push({y:row,life:.45,max:.45});
    const groups=groupCells(e.cells);for(const cells of groups.values())removed.push({cells,life:.25,max:.25});
    for(const cell of e.cells)for(let i=0;i<(reduced?2:10);i++)particles.push({x:OX+(cell.x+.5)*C,y:OY+(cell.y+.5)*C,vx:(Math.random()-.5)*240,vy:-45-Math.random()*140,r:3+Math.random()*7,color:PALETTE[cell.type].light,life:.6+Math.random()*.4,max:1});
    const shifted=new Map(),fallGroups=new Map();
    game.board.forEach((row,y)=>row.forEach((cell,x)=>{if(!cell||e.rows.includes(y))return;const fall=e.rows.filter(r=>r>y).length,old=settles.get(`${cell.id}:${x}:${y}`),startY=(old?.y||0)-fall;if(Math.abs(startY)<.001)return;const token=`${cell.id}:${fall}:${old?.token||''}:${clock}`;let motion=fallGroups.get(token);if(!motion){motion=newBody();motion.y=startY;motion.token=token;fallGroups.set(token,motion);}shifted.set(`${cell.id}:${x}:${y+fall}`,motion);}));settles=shifted;
    const label=['','啵！+100','DOUBLE POP!','TRIPLE POP!','JELLY PARTY!'][e.count]||'JELLY PARTY!';$('clear-toast').textContent=e.count===1?`啵！+${e.points}`:label;$('clear-toast').classList.remove('show');void $('clear-toast').offsetWidth;$('clear-toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('clear-toast').classList.remove('show'),1400);$('announcer').textContent=`消除 ${e.count} 行，加 ${e.points} 分。`;[440,554,659,880].slice(0,Math.min(4,e.count+1)).forEach((f,i)=>tone(f,.2,.03,i*.07,f*1.1));
  }
}
function groupCells(cells){const groups=new Map();for(const c of cells){if(!groups.has(c.id))groups.set(c.id,[]);groups.get(c.id).push(c);}return groups;}
function updateBody(b,dt){if(reduced){b.x=b.y=b.q=b.bend=b.lean=0;return;}b.age+=dt;
  b.vx+=(-90*b.x-14*b.vx)*dt;b.x+=b.vx*dt;
  if(b.y<0||Math.abs(b.vy)>.02){b.vy+=10.8*dt;b.y+=b.vy*dt;if(b.y>=0){b.y=0;if(b.vy>.5){b.q+=Math.min(.3,b.vy*.07);b.vq+=.6;b.vy*=-.24;}else b.vy=0;}}
  b.vq+=(-125*b.q-7.5*b.vq)*dt;b.q+=b.vq*dt;
  b.vb+=(-92*b.bend-6*b.vb)*dt;b.bend+=b.vb*dt;
  b.vl+=(-100*b.lean-7*b.vl)*dt;b.lean+=b.vl*dt;
}
function deformFor(cells,b,fallOffset=0){const minX=Math.min(...cells.map(c=>c.x)),maxX=Math.max(...cells.map(c=>c.x))+1,minY=Math.min(...cells.map(c=>c.y)),bottom=Math.max(...cells.map(c=>c.y))+1,cx=(minX+maxX)/2,height=bottom-minY;
  const q=Math.max(-.35,Math.min(.72,b.q)),slide=b.x;
  return(x,y)=>{
    const up=(bottom-y)/height;
    let px=cx+(x-cx)*(1+q*.22)+slide+b.lean*(y-bottom)+b.bend*Math.sin(up*Math.PI*.75);
    let py=bottom+(y-bottom)*(1-q*.36)+b.y+fallOffset;
    // Small surface waves travel out from the contact edge through the whole gel.
    if(!reduced){const wave=Math.sin((x-cx)*2.4+up*2.3-b.age*13)*Math.exp(-b.age*4)*b.impact*.025;py+=wave*Math.sin(up*Math.PI);}
    px=Math.min(3.985,Math.max(.015,px));
    return{x:px,y:py};
  };
}
function drawWell(){
  ctx.clearRect(0,0,W,H);
  // Open tank and a soft transparent interior; no visible cell grid.
  const water=ctx.createLinearGradient(0,90,0,670);water.addColorStop(0,'#ffffff00');water.addColorStop(1,'#ffffff26');ctx.fillStyle=water;ctx.fillRect(OX,110,320,560);
  ctx.save();ctx.strokeStyle='#354354';ctx.lineWidth=11;ctx.lineJoin='round';ctx.lineCap='butt';ctx.beginPath();ctx.moveTo(OX-6,115);ctx.lineTo(OX-6,OY+640+6);ctx.lineTo(OX+320+6,OY+640+6);ctx.lineTo(OX+320+6,115);ctx.stroke();ctx.strokeStyle='#213244';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(OX,115);ctx.lineTo(OX,OY+640);ctx.lineTo(OX+320,OY+640);ctx.lineTo(OX+320,115);ctx.stroke();ctx.restore();
  ctx.save();ctx.strokeStyle='#3d4d5b99';ctx.lineWidth=3;ctx.setLineDash([45,22]);ctx.beginPath();ctx.moveTo(OX,190);ctx.lineTo(OX+320,190);ctx.stroke();ctx.restore();
}
const idleShapes=[{type:'T',id:-1,cells:[{x:0,y:7},{x:1,y:6},{x:1,y:7},{x:2,y:7}]},{type:'J',id:-2,cells:[{x:0,y:5},{x:1,y:5},{x:2,y:5},{x:0,y:6}]},{type:'O',id:-3,cells:[{x:0,y:2},{x:1,y:2},{x:0,y:3},{x:1,y:3}]}];
function drawScene(dt){
  drawWell();ctx.save();ctx.beginPath();ctx.rect(OX-.5,-20,321,691);ctx.clip();
  if(game.state==='idle'){
    for(const shape of idleShapes){const cells=shape.cells.map(c=>({...c,type:shape.type,id:shape.id}));const b=newBody();if(!reduced){b.q=Math.sin(clock/650+shape.id)*.055;b.bend=Math.sin(clock/740+shape.id)*.035;if(shape.type==='O')b.y=-.2+Math.sin(clock/690)*.09;}renderGel(ctx,cells,{cellSize:C,offsetX:OX,offsetY:OY,type:shape.type,deform:deformFor(cells,b)});}
  }else{
    if(game.active&&game.state!=='over')renderGhost(ctx,game.getCells({...game.active,y:game.ghostY()}),{cellSize:C,offsetX:OX,offsetY:OY,type:game.active.type,alpha:.18});
    const cells=[];game.board.forEach((row,y)=>row.forEach((c,x)=>{if(c)cells.push({...c,x,y});}));
    const groups=new Map();for(const c of cells){const fall=settles.get(`${c.id}:${c.x}:${c.y}`),key=`${c.id}:${fall?.token||'rest'}`;if(!groups.has(key))groups.set(key,{cells:[],fall});groups.get(key).cells.push(c);}for(const {cells:group,fall}of groups.values()){const b=getBody(group[0].id),pose=fall?{...b,y:b.y+fall.y,q:b.q+fall.q}:b;renderGel(ctx,group,{cellSize:C,offsetX:OX,offsetY:OY,type:group[0].type,deform:deformFor(group,pose)});}
    if(game.active){const cells=game.getCells(),b=getBody(game.active.id);renderGel(ctx,cells,{cellSize:C,offsetX:OX,offsetY:OY,type:game.active.type,deform:deformFor(cells,b,game.fallY-game.active.y)});}
  }
  for(const r of removed){const center=r.cells.reduce((s,c)=>s+c.x+.5,0)/r.cells.length;renderGel(ctx,r.cells,{cellSize:C,offsetX:OX,offsetY:OY,type:r.cells[0].type,alpha:r.life/r.max,deform:(x,y)=>({x:center+(x-center)*(r.life/r.max),y:y+(1-r.life/r.max)*.1})});}
  for(const f of clearBands){ctx.globalAlpha=f.life/f.max*.8;const gradient=ctx.createLinearGradient(OX,0,OX+320,0);gradient.addColorStop(0,'#ffffff00');gradient.addColorStop(.4,'#ffffff');gradient.addColorStop(.6,'#ffffff');gradient.addColorStop(1,'#ffffff00');ctx.fillStyle=gradient;ctx.fillRect(OX,OY+f.y*C,320,C);ctx.globalAlpha=1;}
  for(const p of particles){ctx.globalAlpha=Math.max(0,p.life/p.max);ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,Math.max(.1,p.r*p.life/p.max),0,Math.PI*2);ctx.fill();ctx.strokeStyle='#ffffffb0';ctx.lineWidth=1;ctx.stroke();}ctx.globalAlpha=1;ctx.restore();
}
function drawNext(){nextCtx.clearRect(0,0,180,200);const types=game.next.length?game.next.slice(0,3):['T','O','J'];types.forEach((type,i)=>{const cells=[];SHAPES[type].forEach((row,y)=>row.forEach((v,x)=>{if(v)cells.push({x,y});}));const minX=Math.min(...cells.map(c=>c.x)),maxX=Math.max(...cells.map(c=>c.x))+1,minY=Math.min(...cells.map(c=>c.y)),maxY=Math.max(...cells.map(c=>c.y))+1,s=i===0?25:21;renderGel(nextCtx,cells,{cellSize:s,offsetX:(180-(maxX-minX)*s)/2-minX*s,offsetY:15+i*65-minY*s,type,alpha:i===0?1:.72});});}
function fit(element,context,w,h){const dpr=Math.min(2,devicePixelRatio||1);element.width=w*dpr;element.height=h*dpr;context.setTransform(dpr,0,0,dpr,0,0);}
function resize(){fit(canvas,ctx,W,H);fit($('next-canvas'),nextCtx,180,200);drawNext();}
function start(){unlock();bodies.clear();settles.clear();particles=[];clearBands=[];removed=[];clearTimeout(toastTimer);$('clear-toast').classList.remove('show');$('clear-toast').textContent='';$('announcer').textContent='';game.start();syncUI();canvas.focus({preventScroll:true});tone(330,.12,.03);tone(495,.15,.025,.1,660);}
function resume(){unlock();if(game.state==='paused')game.togglePause();else if(game.state!=='playing')start();canvas.focus({preventScroll:true});}
function action(name){if(game.state!=='playing')return;if(name==='left')game.move(-1);if(name==='right')game.move(1);if(name==='rotate')game.rotate();if(name==='drop')game.hardDrop();if(name==='down')game.softDrop();}
function release(){held.clear();document.querySelectorAll('.held').forEach(b=>b.classList.remove('held'));}
$('start-btn').addEventListener('click',resume);$('pause-btn').addEventListener('click',()=>{game.togglePause();canvas.focus({preventScroll:true});});$('restart-btn').addEventListener('click',start);$('sound-btn').addEventListener('click',()=>{sound=!sound;save('jelly-drop-sound',sound);syncSound();unlock();if(sound)tone(440,.1,.02);});
$('help-btn').addEventListener('click',()=>{helpWasPlaying=game.state==='playing';if(helpWasPlaying)game.togglePause();$('help-dialog').showModal();});
function closeHelp(){$('help-dialog').close();if(helpWasPlaying&&game.state==='paused')game.togglePause();helpWasPlaying=false;}
$('close-help').addEventListener('click',closeHelp);$('got-it').addEventListener('click',closeHelp);$('help-dialog').addEventListener('cancel',e=>{e.preventDefault();closeHelp();});
const keys={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'rotate',ArrowDown:'down',' ':'drop',a:'left',d:'right',w:'rotate',s:'down'};
window.addEventListener('keydown',e=>{if($('help-dialog').open)return;const key=e.key.length===1?e.key.toLowerCase():e.key;if(key==='p'||key==='Escape'){if(['playing','paused'].includes(game.state)){e.preventDefault();if(!e.repeat)game.togglePause();}return;}if(key==='Enter'&&game.state!=='playing'&&e.target.tagName!=='BUTTON'){e.preventDefault();resume();return;}const act=keys[key];if(!act||game.state!=='playing'||key===' '&&e.target.tagName==='BUTTON')return;e.preventDefault();if(e.repeat)return;unlock();action(act);if(['left','right'].includes(act))held.set(key,{act,t:0,next:180});});
window.addEventListener('keyup',e=>held.delete(e.key.length===1?e.key.toLowerCase():e.key));
window.addEventListener('blur',()=>{release();if(game.state==='playing')game.togglePause();});document.addEventListener('visibilitychange',()=>{if(document.hidden){release();if(game.state==='playing')game.togglePause();}});
for(const button of document.querySelectorAll('[data-action]')){button.addEventListener('pointerdown',e=>{e.preventDefault();unlock();button.setPointerCapture(e.pointerId);button.classList.add('held');action(button.dataset.action);if(['left','right'].includes(button.dataset.action))held.set(e.pointerId,{act:button.dataset.action,t:0,next:180});});const up=e=>{held.delete(e.pointerId);button.classList.remove('held');};button.addEventListener('pointerup',up);button.addEventListener('pointercancel',up);button.addEventListener('lostpointercapture',up);button.addEventListener('click',e=>{if(e.detail===0)action(button.dataset.action);});}
let gesture=null;canvas.addEventListener('pointerdown',e=>{if(game.state!=='playing')return;unlock();canvas.setPointerCapture(e.pointerId);gesture={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,moved:false};});canvas.addEventListener('pointermove',e=>{if(!gesture||gesture.id!==e.pointerId)return;const threshold=canvas.getBoundingClientRect().width*.16;while(Math.abs(e.clientX-gesture.lastX)>threshold){const dir=Math.sign(e.clientX-gesture.lastX);action(dir>0?'right':'left');gesture.lastX+=dir*threshold;gesture.moved=true;}});canvas.addEventListener('pointerup',e=>{if(!gesture||gesture.id!==e.pointerId)return;if(e.clientY-gesture.y>35)action('drop');else if(!gesture.moved&&Math.abs(e.clientY-gesture.y)<12)action('rotate');gesture=null;});canvas.addEventListener('pointercancel',()=>gesture=null);
function frame(t){const dt=Math.min((t-lastTime)/1000||.016,.033);lastTime=t;if(game.state!=='paused'){clock+=dt*1000;game.update(dt*1000);const live=new Set(game.board.flat().filter(Boolean).map(c=>c.id));if(game.active)live.add(game.active.id);for(const r of removed)for(const c of r.cells)live.add(c.id);for(const id of bodies.keys())if(!live.has(id))bodies.delete(id);for(const b of bodies.values())updateBody(b,dt);for(const b of new Set(settles.values()))updateBody(b,dt);for(const [key,b]of settles)if(b.y===0&&b.vy===0&&Math.abs(b.q)<.01)settles.delete(key);particles=particles.filter(p=>{p.life-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=180*dt;return p.life>0;});clearBands=clearBands.filter(f=>(f.life-=dt)>0);removed=removed.filter(r=>(r.life-=dt)>0);}for(const h of held.values()){h.t+=dt*1000;if(h.t>=h.next){action(h.act);h.next+=110;}}drawScene(dt);syncUI();requestAnimationFrame(frame);}
resize();window.addEventListener('resize',resize);syncSound();syncUI();requestAnimationFrame(frame);
