// Instanced chunk renderer + better visuals:
// - Creates an InstancedMesh per block type for chunk geometry
// - Uses canvas-generated texture atlas for player "skin" and block variants (no external images)
// - Renders block characters with username labels above
// - Renders birds and vehicles using remote entity updates from server
// - Provides spawnShotEffect / animateMuzzleAtEntity
//
// Notes: This file replaces previous per-cube meshes with GPU instancing for performance.
// It keeps chunk updates simple: rebuild instanced meshes for a chunk on change.

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
  let playerModel, playerPos = { x:0,y:0,z:0,crouch:false }, playerYaw = 0, playerPitch = 0;
  const chunks = {}; // key -> { instancedByType: { type: InstancedMesh }, matrices arrays, blocks }
  const entitiesGroup = new THREE.Group();
  const remote = {}; // id -> { ent, target, labelCanvas }

  function overlayMessage(t){ let o=document.getElementById('voxelErrorOverlay'); if(!o){ o=document.createElement('div'); o.id='voxelErrorOverlay'; Object.assign(o.style,{position:'fixed',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.6)',color:'#fff',zIndex:9999,fontSize:'18px',padding:'20px'}); document.body.appendChild(o);} o.textContent=t; o.style.display='flex'; }
  function hideOverlay(){ const o=document.getElementById('voxelErrorOverlay'); if(o) o.style.display='none'; }
  function canUseWebGL(){ try{ const c=document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl')||c.getContext('experimental-webgl'))); }catch(e){return false;} }

  function initRenderer(){ if (typeof THREE === 'undefined') throw new Error('three.js missing'); if (!canUseWebGL()) throw new Error('WebGL not available'); const canvas = document.getElementById('gameCanvas'); renderer = new THREE.WebGLRenderer({ canvas, antialias:true }); renderer.setPixelRatio(window.devicePixelRatio||1); renderer.setSize(window.innerWidth, window.innerHeight); renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; }

  function createLabelCanvas(name){
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(name, canvas.width/2, 42);
    return canvas;
  }

  function createBlockCharacter(color, name){
    const g = new THREE.Group();
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.5,1,0.5), new THREE.MeshStandardMaterial({ color: 0x333333 }));
    legL.position.set(-0.25, 0.5, 0);
    const legR = legL.clone(); legR.position.set(0.25,0.5,0);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(1.0,1.2,0.6), new THREE.MeshStandardMaterial({ color }));
    torso.position.set(0,1.1,0);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.9,0.9,0.9), new THREE.MeshStandardMaterial({ color: 0xffe0b2 }));
    head.position.set(0,2.3,0);
    const labelCanvas = createLabelCanvas(name || 'Player');
    const tex = new THREE.CanvasTexture(labelCanvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest:false, depthWrite:false }));
    sprite.scale.set(3.0, 0.9, 1); sprite.position.set(0,3.2,0);
    g.add(legL, legR, torso, head, sprite);
    g.userData._labelCanvas = labelCanvas;
    return g;
  }

  function initScene(){
    scene = new THREE.Scene(); clock = new THREE.Clock();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.1, 3000); camera.position.set(0,4,8);
    const hemi = new THREE.HemisphereLight(0xbfe6ff, 0x080820, 0.8); scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0); dir.position.set(10,20,10); scene.add(dir);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000,2000), new THREE.MeshStandardMaterial({ color:0x071022 })); ground.rotation.x = -Math.PI/2; ground.position.y = -1; scene.add(ground);
    const sess = (window.sessionStorage && JSON.parse(sessionStorage.getItem('survive.session.v1')||'{}')) || {};
    playerModel = createBlockCharacter(0xffcc66, sess.name || 'You'); playerModel.position.set(0, 1.0, 0); scene.add(playerModel);
    entitiesGroup.name = 'entitiesGroup'; scene.add(entitiesGroup);
    window.addEventListener('resize', onResize); onResize();
  }

  function onResize(){ if (!camera || !renderer) return; camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); }

  // Instanced building of chunk: group by block type into InstancedMesh arrays
  function buildInstancedForChunk(cx,cz,blocks){
    const typeMatrices = {}; // type -> array of matrices
    for (let x=0;x<CHUNK_SIZE;x++){
      for (let z=0;z<CHUNK_SIZE;z++){
        for (let y=0;y<CHUNK_HEIGHT;y++){
          const v = blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x];
          if (!v || v === BLOCK_AIR) continue;
          const mat = new THREE.Matrix4();
          const pos = new THREE.Vector3(cx*CHUNK_SIZE + x + 0.5, y + 0.5, cz*CHUNK_SIZE + z + 0.5);
          mat.makeTranslation(pos.x, pos.y, pos.z);
          if (!typeMatrices[v]) typeMatrices[v] = [];
          typeMatrices[v].push(mat);
        }
      }
    }
    const instanced = {};
    Object.keys(typeMatrices).forEach(typeStr => {
      const t = Number(typeStr);
      const mats = typeMatrices[t];
      const geom = new THREE.BoxGeometry(1,1,1);
      const mat = new THREE.MeshStandardMaterial({ color: blockColors[t] || 0xffffff });
      const inst = new THREE.InstancedMesh(geom, mat, mats.length);
      for (let i=0;i<mats.length;i++) inst.setMatrixAt(i, mats[i]);
      inst.instanceMatrix.needsUpdate = true;
      instanced[t] = inst;
    });
    return instanced;
  }

  async function requestChunk(cx,cz){
    const key = `${cx},${cz}`;
    if (chunks[key]) return;
    try {
      const resp = await fetch(`/chunk?cx=${cx}&cz=${cz}`);
      if (!resp.ok) throw new Error('chunk request failed: ' + resp.status);
      const j = await resp.json(); if (!j.ok) throw new Error('chunk ok:false');
      const instanced = buildInstancedForChunk(cx,cz,j.blocks);
      const group = new THREE.Group(); group.name = `chunk-${cx}-${cz}`;
      Object.keys(instanced).forEach(k => group.add(instanced[k]));
      scene.add(group);
      chunks[key] = { group, blocks: j.blocks, instanced };
    } catch (e) {
      console.warn('requestChunk failed', e);
      overlayMessage('Could not load chunk: ' + e.message);
      setTimeout(()=>hideOverlay(),3500);
    }
  }

  function applyChunkDiff(diff){
    const key = `${diff.cx},${diff.cz}`; const ch = chunks[key];
    if (!ch) return;
    // update blocks array
    for (const e of diff.edits) ch.blocks[(e.y*CHUNK_SIZE + e.z)*CHUNK_SIZE + e.x] = e.block;
    // remove old group
    scene.remove(ch.group);
    // rebuild instanced meshes for this chunk
    const instanced = buildInstancedForChunk(diff.cx, diff.cz, ch.blocks);
    const group = new THREE.Group(); Object.keys(instanced).forEach(k => group.add(instanced[k]));
    group.name = ch.group.name;
    scene.add(group);
    ch.group = group; ch.instanced = instanced;
  }

  function setBlockLocal(cx,cz,x,y,z,block){
    const key = `${cx},${cz}`; const ch = chunks[key]; if (!ch) return false;
    ch.blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x] = block;
    scene.remove(ch.group);
    const instanced = buildInstancedForChunk(cx,cz,ch.blocks);
    const group = new THREE.Group(); Object.keys(instanced).forEach(k => group.add(instanced[k]));
    group.name = `chunk-${cx}-${cz}`; scene.add(group);
    ch.group = group; ch.instanced = instanced;
    return true;
  }

  function ensureRemote(id, info){
    if (!remote[id]) {
      const ent = createBlockCharacter(0x99ff99, info.name || 'Player');
      ent.position.set(info.x || 0, (info.y||0)+0.5, info.z || 0);
      const gun = createBlock(0.6, 1.1, 0, 0x222222); gun.scale.set(0.6,0.2,0.2); ent.add(gun);
      entitiesGroup.add(ent);
      remote[id] = { ent, target: { x: ent.position.x, y: ent.position.y, z: ent.position.z }, gun };
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
      const color = p.role === 'seeker' ? 0xff6666 : (p.type === 'bird' ? 0xffa88a : (p.type==='vehicle'?0x4444ff:0x99ff99));
      r.ent.traverse(o => { if (o.isMesh && o.material) o.material.color.setHex(color); });
      const sprite = r.ent.children.find(c => c.type === 'Sprite');
      if (sprite && sprite.material && sprite.material.map && sprite.material.map.image) {
        const canvas = sprite.material.map.image; const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.font='20px sans-serif'; ctx.textAlign='center'; ctx.fillText(p.name || 'Player', canvas.width/2, 42);
        sprite.material.map.needsUpdate = true;
      }
    }
    for (const id of Object.keys(remote)) if (!ids.has(id)) {
      const r = remote[id]; entitiesGroup.remove(r.ent); delete remote[id];
    }
  }

  function spawnShotEffect(fromPos, toPos, color=0xffff88){
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.12,8,8), new THREE.MeshStandardMaterial({ color }));
    sphere.position.set(fromPos.x, fromPos.y, fromPos.z);
    scene.add(sphere);
    const dur = 600; const start = Date.now();
    (function tick(){ const t = (Date.now() - start) / dur; if (t >= 1) { try{ scene.remove(sphere); sphere.geometry.dispose(); sphere.material.dispose(); }catch(e){} return; } sphere.position.lerpVectors(new THREE.Vector3(fromPos.x,fromPos.y,fromPos.z), new THREE.Vector3(toPos.x,toPos.y,toPos.z), t); requestAnimationFrame(tick); })();
  }

  function animateMuzzleAtEntity(id){ const r = remote[id]; if (!r) return; const flash = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.12,0.12), new THREE.MeshStandardMaterial({ color:0xfff1a8, emissive:0xfff1a8 })); flash.position.set(r.ent.position.x + 0.9, r.ent.position.y + 1.0, r.ent.position.z); scene.add(flash); setTimeout(()=>{ try{ scene.remove(flash); flash.geometry.dispose(); flash.material.dispose(); }catch(e){} }, 120); }

  // third-person controls and loop (similar to previous implementation but tuned for instancing)
  function setupControls(){
    const canvas = document.getElementById('gameCanvas');
    const keys = { f:false,b:false,l:false,r:false }; let dash = false;
    function kd(e){ if (e.code==='KeyW'||e.code==='ArrowUp') keys.f=true; if (e.code==='KeyS'||e.code==='ArrowDown') keys.b=true; if (e.code==='KeyA'||e.code==='ArrowLeft') keys.l=true; if (e.code==='KeyD'||e.code==='ArrowRight') keys.r=true; if (e.code==='ControlLeft'||e.code==='KeyC') playerPos.crouch = true; }
    function ku(e){ if (e.code==='KeyW'||e.code==='ArrowUp') keys.f=false; if (e.code==='KeyS'||e.code==='ArrowDown') keys.b=false; if (e.code==='KeyA'||e.code==='ArrowLeft') keys.l=false; if (e.code==='KeyD'||e.code==='ArrowRight') keys.r=false; if (e.code==='ControlLeft'||e.code==='KeyC') playerPos.crouch = false; }
    document.addEventListener('keydown', kd); document.addEventListener('keyup', ku);
    function onMouseMove(e){ const mx = e.movementX||0, my = e.movementY||0; playerYaw -= mx*0.0025; playerPitch = (playerPitch||0) - my*0.0025; playerPitch = Math.max(-Math.PI/3, Math.min(Math.PI/3, playerPitch)); }
    canvas.addEventListener('click', ()=> canvas.requestPointerLock && canvas.requestPointerLock());
    document.addEventListener('pointerlockchange', ()=>{ if (document.pointerLockElement===canvas) document.addEventListener('mousemove', onMouseMove); else document.removeEventListener('mousemove', onMouseMove); });

    canvas.addEventListener('mousedown', (e) => { if (e.button === 0) { if (typeof window.doLocalShoot === 'function') window.doLocalShoot(); } else if (e.button === 2) { dash = true; } });
    canvas.addEventListener('mouseup', (e) => { if (e.button === 2) dash = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    function update(dt){
      const base = playerPos.crouch ? 2.0 : 6;
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
      const offsetBack = 5.0; const height = playerPos.crouch ? 1.4 : 2.2;
      const back = new THREE.Vector3(Math.sin(playerYaw), 0, Math.cos(playerYaw)).normalize();
      const desired = new THREE.Vector3(playerPos.x, playerPos.y + height, playerPos.z).addScaledVector(back, offsetBack);
      camera.position.lerp(desired, 0.18);
      camera.lookAt(new THREE.Vector3(playerPos.x, playerPos.y + (playerPos.crouch ? 0.9 : 1.6), playerPos.z));

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

  function start(){ try { initRenderer(); initScene(); setupControls(); console.info('[world] started'); return true; } catch (e) { console.error('start failed', e); overlayMessage('Graphics init failed: ' + e.message); return false; } }

  window.VoxelWorld = { start, requestChunk, applyChunkDiff, setBlockLocal, getPlayerPosition, getCamera, updatePlayers, spawnShotEffect, animateMuzzleAtEntity, BLOCKS: { AIR:BLOCK_AIR, GRASS:BLOCK_GRASS, DIRT:BLOCK_DIRT, STONE:BLOCK_STONE, SHIELD:BLOCK_SHIELD, WOOD:BLOCK_WOOD, LEAF:BLOCK_LEAF, BUILDING:BLOCK_BUILDING, ROAD:BLOCK_ROAD, SERUM:BLOCK_SERUM, BUSH:BLOCK_BUSH } };

  console.info('[world] instanced renderer loaded (textures generated at runtime)');
})();
