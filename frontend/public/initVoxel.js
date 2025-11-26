// Advanced renderer (fixed): avoids reading undefined.position, loads human model async (non-blocking),
// ensures playerEntity exists before controls start, and reduces THREE warnings.
// Replace your frontend/public/initVoxel.js with this file and hard-refresh the page.

(async function(){
  if (window.VoxelWorld) return;

  const CHUNK_SIZE = 16, CHUNK_HEIGHT = 32;
  const BLOCK_AIR = 0, BLOCK_GRASS = 1, BLOCK_DIRT = 2, BLOCK_STONE = 3, BLOCK_SHIELD = 4,
        BLOCK_WOOD = 5, BLOCK_LEAF = 6, BLOCK_BUILDING = 7, BLOCK_ROAD = 8, BLOCK_SERUM = 9, BLOCK_BUSH = 10;

  const blockColors = {
    [BLOCK_GRASS]: 0x2d6b3a, [BLOCK_DIRT]: 0x6b4a2a, [BLOCK_STONE]: 0x8a8a8a, [BLOCK_SHIELD]: 0xffd24d,
    [BLOCK_WOOD]: 0x6b3a1a, [BLOCK_LEAF]: 0x3fbf4a, [BLOCK_BUILDING]: 0x4b5563, [BLOCK_ROAD]: 0x2b2b2b, [BLOCK_SERUM]: 0x7afcff, [BLOCK_BUSH]: 0x2fa044
  };

  let scene, camera, renderer, clock;
  let playerEntity = null;
  let playerPos = { x:0, y:0, z:0, crouch:false }, yaw = 0, pitch = 0;
  const chunks = {};
  const entitiesGroup = new THREE.Group();
  const remote = {};
  let humanModel = null;

  // Load GLTF human model asynchronously (non-blocking). If it arrives later, new remotes will use it.
  async function loadHumanModelNonBlocking() {
    try {
      const { GLTFLoader } = await import('https://unpkg.com/three@0.152.2/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      loader.load('/assets/human.glb', (gltf) => { humanModel = gltf; console.info('[world] human model loaded'); }, undefined, (err)=>{ console.warn('human gltf load failed', err); });
    } catch (e) {
      console.warn('GLTF loader not available or failed to import', e);
    }
  }

  function overlayMessage(t){ let o=document.getElementById('voxelErrorOverlay'); if(!o){ o=document.createElement('div'); o.id='voxelErrorOverlay'; Object.assign(o.style,{position:'fixed',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.6)',color:'#fff',zIndex:10000,fontSize:'18px',padding:'20px'}); document.body.appendChild(o);} o.textContent=t; o.style.display='flex'; }
  function hideOverlay(){ const o=document.getElementById('voxelErrorOverlay'); if(o) o.style.display='none'; }
  function canUseWebGL(){ try{ const c=document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl')||c.getContext('experimental-webgl'))); }catch(e){return false;} }

  function initRenderer(){
    if (typeof THREE === 'undefined') throw new Error('three.js missing');
    if (!canUseWebGL()) throw new Error('WebGL not available');
    const canvas = document.getElementById('gameCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    // prefer new API if present
    if ('outputColorSpace' in renderer && THREE && THREE.SRGBColorSpace) {
      try { renderer.outputColorSpace = THREE.SRGBColorSpace; } catch(e){ renderer.outputEncoding = THREE.sRGBEncoding; }
    } else {
      renderer.outputEncoding = THREE.sRGBEncoding;
    }
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }

  function createLabelCanvas(name){
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d'); ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.font='20px sans-serif'; ctx.textAlign='center'; ctx.fillText(name,128,42);
    return canvas;
  }

  function createHumanoidEntity(color, name){
    if (humanModel) {
      const model = humanModel.scene ? humanModel.scene.clone(true) : humanModel.clone(true);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(createLabelCanvas(name)), depthTest:false, depthWrite:false }));
      label.scale.set(2.6,0.8,1); label.position.set(0,3.0,0); model.add(label); model.userData._labelCanvas = label.material.map.image;
      return model;
    }
    // fallback composed humanoid
    const g = new THREE.Group();
    const matCloth = new THREE.MeshStandardMaterial({ color });
    const matSkin = new THREE.MeshStandardMaterial({ color: 0xffe0b2 });
    const leftLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.18,1), matCloth); leftLeg.position.set(-0.18,0.5,0);
    const rightLeg = leftLeg.clone(); rightLeg.position.set(0.18,0.5,0);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6,1.0,0.35), matCloth); torso.position.set(0,1.35,0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24,16,16), matSkin); head.position.set(0,2.28,0);
    g.add(leftLeg, rightLeg, torso, head);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(createLabelCanvas(name)), depthTest:false, depthWrite:false }));
    label.scale.set(2.6,0.8,1); label.position.set(0,3.0,0); g.add(label);
    g.userData._labelCanvas = label.material.map.image;
    return g;
  }

  async function initScene(){
    scene = new THREE.Scene(); clock = new THREE.Clock();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.1, 3000); camera.position.set(0,4,8);
    const hemi = new THREE.HemisphereLight(0xbfe6ff, 0x080820, 0.8); scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0); dir.position.set(10,20,10); scene.add(dir);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000,3000), new THREE.MeshStandardMaterial({ color:0x071022 }));
    ground.rotation.x = -Math.PI/2; ground.position.y = -1; scene.add(ground);

    // start loading human model in background
    loadHumanModelNonBlocking().catch(()=>{});

    // create playerEntity immediately (fallback if human model not yet available)
    playerEntity = createHumanoidEntity(0xffcc66, (window.sessionStorage && JSON.parse(sessionStorage.getItem('survive.session.v1')||'{}')).name || 'You');
    playerEntity.position.set(0,1.0,0);
    scene.add(playerEntity);

    entitiesGroup.name = 'entities'; scene.add(entitiesGroup);
    window.addEventListener('resize', ()=>{ if (!camera || !renderer) return; camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
  }

  async function requestChunk(cx,cz){
    const key = `${cx},${cz}`; if (chunks[key]) return;
    try {
      const resp = await fetch(`/chunk?cx=${cx}&cz=${cz}`);
      if (!resp.ok) throw new Error('chunk request failed: '+resp.status);
      const j = await resp.json(); if (!j.ok) throw new Error('chunk ok:false');
      const blocks = Int8Array.from(j.blocks);
      const group = new THREE.Group(); group.name = `chunk-${cx}-${cz}`;
      for (let x=0;x<CHUNK_SIZE;x++){
        for (let z=0;z<CHUNK_SIZE;z++){
          for (let y=0;y<CHUNK_HEIGHT;y++){
            const v = blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x];
            if (v && v !== BLOCK_AIR) {
              const m = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({ color: blockColors[v] || 0xffffff }));
              m.position.set(cx*CHUNK_SIZE + x + 0.5, y + 0.5, cz*CHUNK_SIZE + z + 0.5);
              group.add(m);
            }
          }
        }
      }
      scene.add(group);
      chunks[key] = { cx, cz, blocks, group };
    } catch (e) {
      console.warn('requestChunk failed', e);
      overlayMessage('Could not load chunk: ' + (e && e.message));
      setTimeout(()=>hideOverlay(), 3000);
    }
  }

  function worldToChunkCoords(x,z){
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const lx = Math.floor(x - cx*CHUNK_SIZE), lz = Math.floor(z - cz*CHUNK_SIZE);
    return { cx, cz, lx, lz };
  }
  function getBlockAtWorld(x, y, z){
    const { cx, cz, lx, lz } = worldToChunkCoords(Math.floor(x), Math.floor(z));
    const key = `${cx},${cz}`; const ch = chunks[key];
    if (!ch) return BLOCK_AIR;
    const by = Math.floor(y);
    if (by < 0 || by >= CHUNK_HEIGHT) return BLOCK_AIR;
    return ch.blocks[(by*CHUNK_SIZE + lz)*CHUNK_SIZE + lx] || BLOCK_AIR;
  }

  function isPositionFree(x, z, height = 1.8){
    const samples = [{x,z},{x:x+0.3,z},{x:x-0.3,z},{x,z:x+0.3},{x,z:z+0.3}];
    // fallback simpler sample loop (avoid earlier typo)
    const samp = [
      {x:x, z:z},
      {x:x+0.3, z:z},
      {x:x-0.3, z:z},
      {x:x, z:z+0.3},
      {x:x, z:z-0.3}
    ];
    for (const s of samp) {
      for (let by = 0; by <= Math.ceil(height); by++) {
        const b = getBlockAtWorld(Math.floor(s.x), by, Math.floor(s.z));
        if (b && b !== BLOCK_AIR) return false;
      }
    }
    return true;
  }

  const hidingMarkers = [];
  function scanHidingSpots(centerX, centerZ, radiusChunks=2){
    hidingMarkers.forEach(m=>scene.remove(m)); hidingMarkers.length = 0;
    const minCx = Math.floor((centerX - CHUNK_SIZE*radiusChunks)/CHUNK_SIZE);
    const maxCx = Math.floor((centerX + CHUNK_SIZE*radiusChunks)/CHUNK_SIZE);
    const minCz = Math.floor((centerZ - CHUNK_SIZE*radiusChunks)/CHUNK_SIZE);
    const maxCz = Math.floor((centerZ + CHUNK_SIZE*radiusChunks)/CHUNK_SIZE);
    for (let cx=minCx; cx<=maxCx; cx++){
      for (let cz=minCz; cz<=maxCz; cz++){
        const key = `${cx},${cz}`; const ch = chunks[key];
        if (!ch) continue;
        for (let x=0;x<CHUNK_SIZE;x++){
          for (let z=0;z<CHUNK_SIZE;z++){
            for (let y=0;y<CHUNK_HEIGHT;y++){
              const v = ch.blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x];
              if (v === BLOCK_BUSH || v === BLOCK_BUILDING || v === BLOCK_WOOD) {
                const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.18,0.5,8), new THREE.MeshStandardMaterial({ color: 0xffcc00 }));
                arrow.position.set(cx*CHUNK_SIZE + x + 0.5, y + 1.2, cz*CHUNK_SIZE + z + 0.5);
                arrow.rotation.x = -Math.PI/2;
                scene.add(arrow); hidingMarkers.push(arrow);
                break;
              }
            }
          }
        }
      }
    }
  }

  let shooterMarkers = [];
  function showShooterMarker(shooterPos, shooterId, duration=4000){
    shooterMarkers.forEach(m=>scene.remove(m)); shooterMarkers = [];
    if (!shooterPos) return;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.45,0.08,8,12), new THREE.MeshStandardMaterial({ color:0xff4444, emissive:0xff4444 }));
    ring.position.set(shooterPos.x, shooterPos.y+1.6, shooterPos.z);
    scene.add(ring); shooterMarkers.push(ring);
    const start = new THREE.Vector3(playerPos.x, (playerPos.y||1)+1.6, playerPos.z);
    const end = new THREE.Vector3(shooterPos.x, shooterPos.y+1.6, shooterPos.z);
    const geom = new THREE.BufferGeometry().setFromPoints([start,end]);
    const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color:0xff6666 }));
    scene.add(line); shooterMarkers.push(line);
    setTimeout(()=>{ shooterMarkers.forEach(m=>scene.remove(m)); shooterMarkers = []; }, duration);
  }

  function setupControls(){
    const canvas = document.getElementById('gameCanvas');
    const keys = { f:false,b:false,l:false,r:false }; let dash=false;
    function kd(e){ if (e.code==='KeyW'||e.code==='ArrowUp') keys.f=true; if (e.code==='KeyS'||e.code==='ArrowDown') keys.b=true; if (e.code==='KeyA'||e.code==='ArrowLeft') keys.l=true; if (e.code==='KeyD'||e.code==='ArrowRight') keys.r=true; if (e.code==='ControlLeft'||e.code==='KeyC') playerPos.crouch = true; }
    function ku(e){ if (e.code==='KeyW'||e.code==='ArrowUp') keys.f=false; if (e.code==='KeyS'||e.code==='ArrowDown') keys.b=false; if (e.code==='KeyA'||e.code==='ArrowLeft') keys.l=false; if (e.code==='KeyD'||e.code==='ArrowRight') keys.r=false; if (e.code==='ControlLeft'||e.code==='KeyC') playerPos.crouch = false; }
    document.addEventListener('keydown', kd); document.addEventListener('keyup', ku);
    function onMouseMove(e){ const mx=e.movementX||0, my=e.movementY||0; yaw -= mx*0.0025; pitch = Math.max(-Math.PI/3, Math.min(Math.PI/3, (pitch||0) - my*0.0025)); }
    canvas.addEventListener('click', ()=> canvas.requestPointerLock && canvas.requestPointerLock());
    document.addEventListener('pointerlockchange', ()=>{ if (document.pointerLockElement===canvas) document.addEventListener('mousemove', onMouseMove); else document.removeEventListener('mousemove', onMouseMove); });

    canvas.addEventListener('mousedown', (e)=>{ if (e.button === 0) { if (typeof window.doLocalShoot === 'function') window.doLocalShoot(); } else if (e.button === 2) { dash = true; }});
    canvas.addEventListener('mouseup', (e)=>{ if (e.button === 2) dash = false; });
    canvas.addEventListener('contextmenu', (e)=> e.preventDefault());

    function update(dt){
      const speed = playerPos.crouch ? 2.2 : 6;
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), forward).normalize();
      const mv = new THREE.Vector3();
      if (keys.f) mv.addScaledVector(forward, speed*dt);
      if (keys.b) mv.addScaledVector(forward, -speed*dt);
      if (keys.l) mv.addScaledVector(right, -speed*dt);
      if (keys.r) mv.addScaledVector(right, speed*dt);
      if (dash) mv.addScaledVector(forward, speed*dt*1.6);
      const nx = playerPos.x + mv.x, nz = playerPos.z + mv.z;
      const phase = !!window._myPhaseActive;
      if (phase || isPositionFree(nx, nz)) {
        playerPos.x = nx; playerPos.z = nz;
        if (playerEntity) playerEntity.position.set(playerPos.x, playerEntity.position.y, playerPos.z);
      }
      const back = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
      const desired = new THREE.Vector3(playerPos.x, playerPos.y + (playerPos.crouch ? 1.4 : 2.2), playerPos.z).addScaledVector(back, 5);
      camera.position.lerp(desired, 0.18);
      camera.lookAt(new THREE.Vector3(playerPos.x, playerPos.y + 1.3, playerPos.z));
      for (const id of Object.keys(remote)){
        const r = remote[id];
        if (!r || !r.ent) continue;
        r.ent.position.x += (r.target.x - r.ent.position.x) * Math.min(1, dt*6);
        r.ent.position.y += (r.target.y - r.ent.position.y) * Math.min(1, dt*6);
        r.ent.position.z += (r.target.z - r.ent.position.z) * Math.min(1, dt*6);
      }
    }
    function animate(){ requestAnimationFrame(animate); const dt = Math.min(0.05, clock.getDelta()); try { update(dt); } catch (e) { console.warn('update loop error', e); } renderer.render(scene,camera); }
    animate();
  }

  function ensureRemote(id, info){
    if (!remote[id]) {
      const ent = createHumanoidEntity(info.role === 'seeker' ? 0xff6666 : 0x99ff99, info.name || 'Player');
      ent.position.set(info.x || 0, (info.y||0)+0.5, info.z || 0);
      entitiesGroup.add(ent);
      remote[id] = { ent, target: { x: ent.position.x, y: ent.position.y, z: ent.position.z } };
    }
    return remote[id];
  }

  function updatePlayers(list){
    const ids = new Set();
    for (const p of list) {
      ids.add(p.id);
      if (p.id === (window.myId || '')) continue;
      const r = ensureRemote(p.id, p);
      r.target.x = p.x || 0; r.target.y = (p.y||0)+0.5; r.target.z = p.z || 0;
      if (r.ent && r.ent.userData && r.ent.userData._labelCanvas) {
        const canvas = r.ent.userData._labelCanvas; const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,canvas.width,canvas.height); ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.font='18px sans-serif'; ctx.textAlign='center';
        ctx.fillText(p.name || 'Player', canvas.width/2, 42);
        const spr = r.ent.children.find(c=>c.type==='Sprite'); if (spr) spr.material.map.needsUpdate = true;
      }
    }
    for (const id of Object.keys(remote)) if (!ids.has(id)) { if (remote[id] && remote[id].ent) scene.remove(remote[id].ent); delete remote[id]; }
  }

  function spawnShotEffect(from, to, color=0xffff88){
    if (!from || !to) return;
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.12,8,8), new THREE.MeshStandardMaterial({ color }));
    s.position.set(from.x, from.y, from.z); scene.add(s);
    const dur=600, start=Date.now();
    (function tick(){ const t=(Date.now()-start)/dur; if(t>=1){ try{ scene.remove(s); s.geometry.dispose(); s.material.dispose(); }catch(e){} return; } s.position.lerpVectors(new THREE.Vector3(from.x,from.y,from.z), new THREE.Vector3(to.x,to.y,to.z), t); requestAnimationFrame(tick); })();
  }

  // public API
  window.VoxelWorld = {
    start: function(){ try{ initRenderer(); initScene(); setupControls(); return true; } catch(e){ console.error('VoxelWorld start failed', e); overlayMessage('Graphics init failed: ' + (e && e.message)); return false; } },
    requestChunk,
    applyChunkDiff: function(diff){
      const key = `${diff.cx},${diff.cz}`; const ch = chunks[key]; if (!ch) return;
      for (const e of diff.edits) ch.blocks[(e.y*CHUNK_SIZE + e.z)*CHUNK_SIZE + e.x] = e.block;
      if (ch.group) scene.remove(ch.group);
      const group = new THREE.Group(); group.name = `chunk-${diff.cx}-${diff.cz}`;
      for (let x=0;x<CHUNK_SIZE;x++) for (let z=0;z<CHUNK_SIZE;z++) for (let y=0;y<CHUNK_HEIGHT;y++){
        const v = ch.blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x];
        if (v && v !== BLOCK_AIR) { const m = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({ color:blockColors[v]||0xffffff })); m.position.set(diff.cx*CHUNK_SIZE + x + 0.5, y + 0.5, diff.cz*CHUNK_SIZE + z + 0.5); group.add(m); }
      }
      scene.add(group); ch.group = group;
    },
    setBlockLocal: function(cx,cz,x,y,z,block){
      const key = `${cx},${cz}`; const ch = chunks[key]; if (!ch) return false;
      ch.blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x] = block;
      this.applyChunkDiff({ cx, cz, edits: [{ x,y,z,block }] });
      return true;
    },
    getPlayerPosition: function(){ return { x: playerPos.x, y: playerPos.y, z: playerPos.z, crouch: !!playerPos.crouch }; },
    getCamera: function(){ return camera; },
    updatePlayers,
    spawnShotEffect,
    animateMuzzleAtEntity: function(id){ const r = remote[id]; if (!r || !r.ent) return; const flash = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.12,0.12), new THREE.MeshStandardMaterial({ color:0xfff1a8, emissive:0xfff1a8 })); flash.position.set(r.ent.position.x + 0.5, r.ent.position.y + 1.0, r.ent.position.z); scene.add(flash); setTimeout(()=>{ try{ scene.remove(flash); flash.geometry.dispose(); flash.material.dispose(); }catch(e){} }, 120); },
    isPositionFree,
    scanHidingSpots,
    clearHidingMarkers: function(){ hidingMarkers.forEach(m=>scene.remove(m)); hidingMarkers.length = 0; },
    showShooterMarker
  };

  console.info('[world] advanced renderer ready (fixed)');
})();
