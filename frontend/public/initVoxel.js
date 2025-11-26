// Client renderer: improved visuals, birds/trucks, muzzle flash, visible shooter highlighting,
// third-person view, username label above players, serum/shield visuals and crouch support.
//
// Replace your frontend/public/initVoxel.js with this file.

(function(){
  if (window.VoxelWorld) return;

  const CHUNK_SIZE = 16, CHUNK_HEIGHT = 32;
  const BLOCK_AIR = 0, BLOCK_GRASS = 1, BLOCK_DIRT = 2, BLOCK_STONE = 3, BLOCK_SHIELD = 4,
        BLOCK_WOOD = 5, BLOCK_LEAF = 6, BLOCK_BUILDING = 7, BLOCK_ROAD = 8, BLOCK_SERUM = 9, BLOCK_BUSH = 10;

  const blockColors = {
    [BLOCK_GRASS]: 0x2d6b3a, [BLOCK_DIRT]: 0x6b4a2a, [BLOCK_STONE]: 0x8a8a8a, [BLOCK_SHIELD]: 0xffd24d,
    [BLOCK_WOOD]: 0x6b3a1a, [BLOCK_LEAF]: 0x3fbf4a, [BLOCK_BUILDING]: 0x4b5563, [BLOCK_ROAD]: 0x2b2b2b,
    [BLOCK_SERUM]: 0x7afcff, [BLOCK_BUSH]: 0x2fa044
  };

  let scene, camera, renderer, clock;
  let playerModel, playerPos = { x:0, y:0, z:0, crouch:false }, playerYaw = 0, playerPitch = 0;
  const chunks = {};
  const entitiesGroup = new THREE.Group();
  const remote = {}; // id -> { ent, target, label, gun }

  function overlayMessage(t){ let o=document.getElementById('voxelErrorOverlay'); if(!o){ o=document.createElement('div'); o.id='voxelErrorOverlay'; Object.assign(o.style,{position:'fixed',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.6)',color:'#fff',zIndex:9999,fontSize:'18px',padding:'20px'}); document.body.appendChild(o);} o.textContent=t; o.style.display='flex'; }
  function hideOverlay(){ const o=document.getElementById('voxelErrorOverlay'); if(o) o.style.display='none'; }
  function canUseWebGL(){ try{ const c=document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl')||c.getContext('experimental-webgl'))); }catch(e){return false;} }

  function initRenderer(){
    if (typeof THREE === 'undefined') throw new Error('three.js missing');
    if (!canUseWebGL()) throw new Error('WebGL not available');
    const canvas = document.getElementById('gameCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.setClearColor(0x0a0a12, 1);
  }

  function createBlock(x,y,z,color){ const g=new THREE.BoxGeometry(1,1,1); const m=new THREE.MeshStandardMaterial({ color }); const mesh=new THREE.Mesh(g,m); mesh.position.set(x,y,z); return mesh; }

  function createLabelSprite(text){
    const canvas = document.createElement('canvas'); canvas.width=256; canvas.height=64;
    const ctx = canvas.getContext('2d'); ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.font='20px sans-serif'; ctx.textAlign='center'; ctx.fillText(text,128,42);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map:tex, depthTest:false, depthWrite:false });
    const s = new THREE.Sprite(mat); s.scale.set(3.0,0.9,1); return s;
  }

  function createBlockCharacter(color, name){
    const g = new THREE.Group();
    const legL = createBlock(-0.22,0,0,0x333333);
    const legR = createBlock(0.22,0,0,0x333333);
    const torso = createBlock(0,1,0,color); torso.scale.set(1.0,1.3,0.6);
    const head = createBlock(0,2.3,0,0xffe0b2); head.scale.set(0.9,0.9,0.9);
    const label = createLabelSprite(name || 'Player'); label.position.set(0,3.0,0);
    g.add(legL, legR, torso, head, label);
    g.userData._labelCanvas = label.material.map.image;
    return g;
  }

  function initScene(){
    scene = new THREE.Scene(); clock = new THREE.Clock();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.1, 3000);
    camera.position.set(0,4,8);

    const hemi = new THREE.HemisphereLight(0xbfe6ff, 0x080820, 0.8); scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.2); dir.position.set(10, 20, 10); scene.add(dir);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000,2000), new THREE.MeshStandardMaterial({ color:0x071022 }));
    ground.rotation.x = -Math.PI/2; ground.position.y = -1; scene.add(ground);

    const sess = (window.sessionStorage && JSON.parse(sessionStorage.getItem('survive.session.v1') || '{}')) || {};
    playerModel = createBlockCharacter(0xffcc66, sess.name || 'You');
    playerModel.position.set(0,1.0,0);
    scene.add(playerModel);

    entitiesGroup.name='entities'; scene.add(entitiesGroup);
    window.addEventListener('resize', onResize); onResize();
  }

  function onResize(){ if(!camera||!renderer) return; camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); }

  function createChunkGroup(cx,cz, blocks){
    const group = new THREE.Group();
    for (let x=0;x<CHUNK_SIZE;x++){
      for (let z=0;z<CHUNK_SIZE;z++){
        for (let y=0;y<CHUNK_HEIGHT;y++){
          const v = blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x];
          if (v && v !== BLOCK_AIR) {
            const col = blockColors[v] || 0xffffff;
            const m = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({ color: col }));
            m.position.set(cx*CHUNK_SIZE + x + 0.5, y + 0.5, cz*CHUNK_SIZE + z + 0.5);
            group.add(m);
          }
        }
      }
    }
    return group;
  }

  async function requestChunk(cx,cz){
    const key = `${cx},${cz}`; if (chunks[key]) return;
    try {
      const resp = await fetch(`/chunk?cx=${cx}&cz=${cz}`);
      if (!resp.ok) throw new Error('chunk request failed: '+resp.status);
      const j = await resp.json(); if (!j.ok) throw new Error('chunk ok:false');
      const grp = createChunkGroup(cx,cz,j.blocks); grp.name = `chunk-${cx}-${cz}`; scene.add(grp); chunks[key] = { group:grp, blocks:j.blocks, cx, cz };
    } catch (e) { console.warn('chunk load failed', e); overlayMessage('Could not load chunk: '+e.message); setTimeout(()=>hideOverlay(),3500); }
  }

  function applyChunkDiff(diff){
    const key = `${diff.cx},${diff.cz}`; const ch = chunks[key]; if (!ch) return;
    for (const e of diff.edits) ch.blocks[(e.y*CHUNK_SIZE + e.z)*CHUNK_SIZE + e.x] = e.block;
    scene.remove(ch.group);
    const newGroup = createChunkGroup(diff.cx,diff.cz,ch.blocks); newGroup.name = ch.group.name; scene.add(newGroup); ch.group = newGroup;
  }

  function setBlockLocal(cx,cz,x,y,z,block){
    const key = `${cx},${cz}`; const ch = chunks[key]; if (!ch) return false;
    ch.blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x] = block;
    scene.remove(ch.group); ch.group = createChunkGroup(cx,cz,ch.blocks); scene.add(ch.group); return true;
  }

  function ensureRemote(id, info){
    if (!remote[id]) {
      const ent = createBlockCharacter(0x99ff99, info.name || 'Player');
      ent.position.set(info.x || 0, (info.y||0)+0.5, info.z || 0);
      // attach gun block
      const gun = createBlock(0.6,1.1,0,0x222222); gun.scale.set(0.6,0.2,0.2); ent.add(gun);
      entitiesGroup.add(ent);
      remote[id] = { ent, target:{ x: ent.position.x, y:ent.position.y, z:ent.position.z }, gun };
    }
    return remote[id];
  }

  function removeRemote(id){ const r=remote[id]; if(!r) return; entitiesGroup.remove(r.ent); delete remote[id]; }

  function updatePlayers(list){
    const ids = new Set();
    for (const p of list){
      ids.add(p.id);
      if (p.id === (window.myId || '')) continue;
      const r = ensureRemote(p.id, p);
      r.target.x = p.x || 0; r.target.y = (p.y||0)+0.5; r.target.z = p.z || 0;
      const color = p.role === 'seeker' ? 0xff6666 : (p.type === 'bird' ? 0xffa88a : (p.type==='vehicle'?0x4444ff:0x99ff99));
      r.ent.traverse(o => { if (o.isMesh && o.material) o.material.color.setHex(color); });
      // update label canvas
      const sprite = r.ent.children.find(c => c.type === 'Sprite');
      if (sprite && sprite.material && sprite.material.map && sprite.material.map.image) {
        const canvas = sprite.material.map.image;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.font='20px sans-serif'; ctx.textAlign='center';
        ctx.fillText(p.name || 'Player', canvas.width/2, 42);
        sprite.material.map.needsUpdate = true;
      }
    }
    for (const id of Object.keys(remote)) if (!ids.has(id)) removeRemote(id);
  }

  function spawnShotEffect(fromPos, toPos, color=0xffff88){
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.12,8,8), new THREE.MeshStandardMaterial({ color }));
    sphere.position.set(fromPos.x, fromPos.y, fromPos.z);
    scene.add(sphere);
    const dura = 600; const start = Date.now();
    (function tick(){ const t = (Date.now()-start)/dura; if (t>=1){ try{ scene.remove(sphere); sphere.geometry.dispose(); sphere.material.dispose(); }catch(e){} return; } sphere.position.lerpVectors(new THREE.Vector3(fromPos.x,fromPos.y,fromPos.z), new THREE.Vector3(toPos.x,toPos.y,toPos.z), t); requestAnimationFrame(tick); })();
  }

  function animateMuzzleAtEntity(id){
    const r = remote[id]; if (!r) return;
    const flash = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.12,0.12), new THREE.MeshStandardMaterial({ color:0xfff1a8, emissive:0xfff1a8 }));
    flash.position.set(r.ent.position.x + 0.9, r.ent.position.y + 1.0, r.ent.position.z);
    scene.add(flash);
    setTimeout(()=>{ try{ scene.remove(flash); flash.geometry.dispose(); flash.material.dispose(); }catch(e){} }, 120);
  }

  // third-person follow + controls
  function updateCameraFollow(){
    const offset = 5.0; const h = playerPos.crouch ? 1.4 : 2.2;
    const back = new THREE.Vector3(Math.sin(playerYaw), 0, Math.cos(playerYaw)).normalize();
    const desired = new THREE.Vector3(playerPos.x, playerPos.y + h, playerPos.z).addScaledVector(back, offset);
    camera.position.lerp(desired, 0.18);
    camera.lookAt(new THREE.Vector3(playerPos.x, playerPos.y + (playerPos.crouch?0.9:1.6), playerPos.z));
  }

  function setupControls(){
    const canvas = document.getElementById('gameCanvas');
    const keys = { f:false,b:false,l:false,r:false };
    function kd(e){ if (e.code==='KeyW'||e.code==='ArrowUp') keys.f=true; if (e.code==='KeyS'||e.code==='ArrowDown') keys.b=true; if (e.code==='KeyA'||e.code==='ArrowLeft') keys.l=true; if (e.code==='KeyD'||e.code==='ArrowRight') keys.r=true; if (e.code==='ControlLeft'||e.code==='KeyC') playerPos.crouch = true; }
    function ku(e){ if (e.code==='KeyW'||e.code==='ArrowUp') keys.f=false; if (e.code==='KeyS'||e.code==='ArrowDown') keys.b=false; if (e.code==='KeyA'||e.code==='ArrowLeft') keys.l=false; if (e.code==='KeyD'||e.code==='ArrowRight') keys.r=false; if (e.code==='ControlLeft'||e.code==='KeyC') playerPos.crouch = false; }
    document.addEventListener('keydown', kd); document.addEventListener('keyup', ku);

    function onMouseMove(e){ const mx = e.movementX||0, my = e.movementY||0; playerYaw -= mx*0.0025; playerPitch = (playerPitch||0) - my*0.0025; playerPitch = Math.max(-Math.PI/3, Math.min(Math.PI/3, playerPitch)); }
    canvas.addEventListener('click', ()=> canvas.requestPointerLock && canvas.requestPointerLock());
    document.addEventListener('pointerlockchange', ()=>{ if (document.pointerLockElement === canvas) document.addEventListener('mousemove', onMouseMove); else document.removeEventListener('mousemove', onMouseMove); });

    // left click (shoot), right click (dash forward while held)
    let dash = false;
    canvas.addEventListener('mousedown', (e)=> {
      if (e.button === 0) { // left
        if (typeof window.doLocalShoot === 'function') window.doLocalShoot(); // call higher-level to send shoot
      } else if (e.button === 2) { dash = true; }
    });
    canvas.addEventListener('mouseup', (e)=> { if (e.button === 2) dash = false; });
    canvas.addEventListener('contextmenu', (e)=> e.preventDefault());

    function update(dt){
      const base = playerPos.crouch ? 2.2 : 6;
      const forward = new THREE.Vector3(Math.sin(playerYaw), 0, Math.cos(playerYaw)).normalize();
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), forward).normalize();
      const mv = new THREE.Vector3();
      if (keys.f) mv.addScaledVector(forward, base*dt);
      if (keys.b) mv.addScaledVector(forward, -base*dt);
      if (keys.l) mv.addScaledVector(right, -base*dt);
      if (keys.r) mv.addScaledVector(right, base*dt);
      if (dash) mv.addScaledVector(forward, base*dt*1.6);
      playerPos.x += mv.x; playerPos.z += mv.z;
      playerModel.position.set(playerPos.x, playerPos.y + (playerPos.crouch ? 0.6 : 1.0), playerPos.z);
      updateCameraFollow();

      for (const id of Object.keys(remote)) {
        const r = remote[id];
        r.ent.position.x += (r.target.x - r.ent.position.x) * Math.min(1, dt*6);
        r.ent.position.y += (r.target.y - r.ent.position.y) * Math.min(1, dt*6);
        r.ent.position.z += (r.target.z - r.ent.position.z) * Math.min(1, dt*6);
      }
    }

    function animate(){ requestAnimationFrame(animate); const dt = Math.min(0.05, clock.getDelta()); update(dt); renderer.render(scene,camera); }
    animate();
  }

  function getCamera(){ return camera; }
  function getPlayerPosition(){ return { x: playerPos.x, y: playerPos.y, z: playerPos.z, crouch: !!playerPos.crouch }; }

  function start(){ try { initRenderer(); initScene(); setupControls(); console.info('[world] started'); return true; } catch (e) { console.error('[world] start failed', e); overlayMessage('Graphics init failed: ' + e.message); return false; } }

  window.VoxelWorld = { start, requestChunk, applyChunkDiff, setBlockLocal, getPlayerPosition, getCamera, updatePlayers, spawnShotEffect, animateMuzzleAtEntity, BLOCKS: { AIR:BLOCK_AIR, GRASS:BLOCK_GRASS, DIRT:BLOCK_DIRT, STONE:BLOCK_STONE, SHIELD:BLOCK_SHIELD, WOOD:BLOCK_WOOD, LEAF:BLOCK_LEAF, BUILDING:BLOCK_BUILDING, ROAD:BLOCK_ROAD, SERUM:BLOCK_SERUM, BUSH:BLOCK_BUSH } };

  console.info('[world] VoxelWorld ready (third-person, birds, trucks, serum, shields)');
})();
