// Frontend renderer (advanced): instanced pooled renderer, texture atlas attempts, GLTF player model loader fallback,
// third-person camera, block characters if GLTF not available, bird flock smoothing, vehicles rendering.
// Loads /assets/player.glb and /assets/atlas.png if present. Falls back to canvas-based visuals otherwise.
//
// Replace frontend/public/initVoxel.js with this file. Ensure three is loaded in index.html as before.

(async function(){
  if (window.VoxelWorld) return;

  const CHUNK_SIZE = 16, CHUNK_HEIGHT = 32;
  const BLOCK_AIR=0, GRASS=1, DIRT=2, STONE=3, SHIELD=4, WOOD=5, LEAF=6, BUILDING=7, ROAD=8, SERUM=9, BUSH=10;
  const BLOCK_TYPES = [GRASS,DIRT,STONE,SHIELD,WOOD,LEAF,BUILDING,ROAD,SERUM,BUSH];
  const blockColors = { [GRASS]:0x2d6b3a, [DIRT]:0x6b4a2a, [STONE]:0x8a8a8a, [SHIELD]:0xffd24d, [WOOD]:0x6b3a1a, [LEAF]:0x3fbf4a, [BUILDING]:0x4b5563, [ROAD]:0x2b2b2b, [SERUM]:0x7afcff, [BUSH]:0x2fa044 };

  let scene, camera, renderer, clock;
  let playerModel, playerYaw = 0, playerPitch = 0;
  let playerPos = { x:0,y:0,z:0,crouch:false };
  const chunks = {};
  const instancedPool = {};
  const entitiesGroup = new THREE.Group();
  const remote = {};
  let gltfPlayer = null, atlasTexture = null;

  function overlayMessage(t){ let o=document.getElementById('voxelErrorOverlay'); if(!o){ o=document.createElement('div'); o.id='voxelErrorOverlay'; Object.assign(o.style,{position:'fixed',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.6)',color:'#fff',zIndex:9999,fontSize:'18px',padding:'20px'}); document.body.appendChild(o);} o.textContent=t; o.style.display='flex'; }
  function hideOverlay(){ const o=document.getElementById('voxelErrorOverlay'); if(o) o.style.display='none'; }
  function canUseWebGL(){ try{ const c=document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl')||c.getContext('experimental-webgl'))); }catch(e){return false;} }

  async function tryLoadAssets(){
    try {
      // dynamic import GLTFLoader
      const { GLTFLoader } = await import('https://unpkg.com/three@0.152.2/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      // atlas and glb URLs: /assets/atlas.png, /assets/player.glb
      const atlasUrl = '/assets/atlas.png';
      try {
        atlasTexture = new THREE.TextureLoader().load(atlasUrl);
        atlasTexture.encoding = THREE.sRGBEncoding;
      } catch(e) { atlasTexture = null; }
      try {
        const gltf = await new Promise((res, rej)=> loader.load('/assets/player.glb', res, null, rej));
        gltfPlayer = gltf.scene || gltf.scenes && gltf.scenes[0];
      } catch(e) {
        gltfPlayer = null;
      }
    } catch(e) {
      // module load failed -> fall back to canvas-based visuals
      atlasTexture = null; gltfPlayer = null;
    }
  }

  function createLabelCanvas(name){
    const c = document.createElement('canvas'); c.width=256; c.height=64;
    const ctx = c.getContext('2d'); ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.font='20px sans-serif'; ctx.textAlign='center'; ctx.fillText(name, c.width/2, 42);
    return c;
  }

  function createCharacterEntity(opts={color:0x99ff99, name:'Player', useGLTF:false}) {
    if (opts.useGLTF && gltfPlayer) {
      const inst = gltfPlayer.clone(true);
      inst.traverse(n => { if (n.isMesh) n.castShadow = true; });
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(createLabelCanvas(opts.name)), depthTest:false, depthWrite:false }));
      label.scale.set(3,0.9,1); label.position.set(0,3.2,0);
      inst.add(label);
      inst.userData._labelCanvas = label.material.map.image;
      return inst;
    }
    // fallback block-character
    const g = new THREE.Group();
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.5,1,0.5), new THREE.MeshStandardMaterial({ color:0x333333 }));
    legL.position.set(-0.25,0.5,0);
    const legR = legL.clone(); legR.position.set(0.25,0.5,0);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(1.0,1.2,0.6), new THREE.MeshStandardMaterial({ color: opts.color }));
    torso.position.set(0,1.1,0);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.9,0.9,0.9), new THREE.MeshStandardMaterial({ color:0xffe0b2 }));
    head.position.set(0,2.3,0);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(createLabelCanvas(opts.name)), depthTest:false, depthWrite:false }));
    label.scale.set(3,0.9,1); label.position.set(0,3.2,0);
    g.add(legL, legR, torso, head, label);
    g.userData._labelCanvas = label.material.map.image;
    return g;
  }

  function getInstancedMeshForType(type, capacity = CHUNK_SIZE*CHUNK_SIZE) {
    instancedPool[type] = instancedPool[type] || [];
    if (instancedPool[type].length) return instancedPool[type].pop();
    const geom = new THREE.BoxGeometry(1,1,1);
    const mat = atlasTexture ? new THREE.MeshStandardMaterial({ map: atlasTexture }) : new THREE.MeshStandardMaterial({ color: blockColors[type] || 0xffffff });
    const mesh = new THREE.InstancedMesh(geom, mat, capacity);
    mesh.countUsed = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }
  function releaseInstancedMesh(m, type) { if (!m) return; m.countUsed = 0; instancedPool[type] = instancedPool[type] || []; instancedPool[type].push(m); }

  function initRenderer(){
    if (typeof THREE === 'undefined') throw new Error('three.js required');
    if (!canUseWebGL()) throw new Error('WebGL not available');
    const canvas = document.getElementById('gameCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputEncoding = THREE.sRGBEncoding;
  }

  function initScene(){
    scene = new THREE.Scene();
    clock = new THREE.Clock();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.1, 3000);
    camera.position.set(0,4,8);
    const hemi = new THREE.HemisphereLight(0xbfe6ff, 0x080820, 0.8); scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0); dir.position.set(10,20,10); scene.add(dir);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000,3000), new THREE.MeshStandardMaterial({ color: 0x071022 }));
    ground.rotation.x = -Math.PI/2; ground.position.y = -1; scene.add(ground);
    playerModel = createCharacterEntity({ color: 0xffcc66, name: (window.sessionStorage && JSON.parse(sessionStorage.getItem('survive.session.v1')||'{}').name) || 'You', useGLTF: !!gltfPlayer });
    playerModel.position.set(0,1.0,0);
    scene.add(playerModel);
    entitiesGroup.name = 'entities'; scene.add(entitiesGroup);
    window.addEventListener('resize', onResize);
    onResize();
  }

  function onResize(){ if (!camera || !renderer) return; camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); }

  // build instanced maps for chunk
  function buildInstancedForChunk(cx,cz,blocks) {
    const counts = {};
    for (let i=0;i<blocks.length;i++){ const v = blocks[i]; if (!v || v===BLOCK_AIR) continue; counts[v] = (counts[v]||0) + 1; }
    const instanced = {};
    for (const tStr of Object.keys(counts)) {
      const t = Number(tStr);
      const mesh = getInstancedMeshForType(t, Math.max(1, counts[t]));
      mesh.countUsed = 0;
      instanced[t] = mesh;
    }
    for (let x=0;x<CHUNK_SIZE;x++){
      for (let z=0;z<CHUNK_SIZE;z++){
        for (let y=0;y<CHUNK_HEIGHT;y++){
          const v = blocks[(y*CHUNK_SIZE+z)*CHUNK_SIZE + x];
          if (!v || v===BLOCK_AIR) continue;
          const mesh = instanced[v];
          const mat = new THREE.Matrix4();
          const px = cx*CHUNK_SIZE + x + 0.5, py = y+0.5, pz = cz*CHUNK_SIZE + z + 0.5;
          mat.makeTranslation(px,py,pz);
          mesh.setMatrixAt(mesh.countUsed++, mat);
        }
      }
    }
    Object.values(instanced).forEach(m => { m.instanceMatrix.needsUpdate = true; m.count = m.countUsed; });
    return instanced;
  }

  async function requestChunk(cx,cz) {
    const key = `${cx},${cz}`; if (chunks[key]) return;
    try {
      const resp = await fetch(`/chunk?cx=${cx}&cz=${cz}`);
      if (!resp.ok) throw new Error('chunk fetch failed: ' + resp.status);
      const j = await resp.json(); if (!j.ok) throw new Error('chunk ok:false');
      const instanced = buildInstancedForChunk(cx,cz,j.blocks);
      const group = new THREE.Group(); group.name = `chunk-${cx}-${cz}`;
      Object.keys(instanced).forEach(k => group.add(instanced[k]));
      scene.add(group);
      chunks[key] = { group, blocks: j.blocks, instanced, cx, cz };
    } catch (e) {
      console.warn('requestChunk failed', e); overlayMessage('Could not load chunk: '+e.message); setTimeout(()=>hideOverlay(),3500);
    }
  }

  function applyChunkDiff(diff){
    const key = `${diff.cx},${diff.cz}`; const ch = chunks[key];
    if (!ch) return;
    for (const e of diff.edits) ch.blocks[(e.y*CHUNK_SIZE + e.z)*CHUNK_SIZE + e.x] = e.block;
    // remove old group and release meshes
    try {
      if (ch.group) {
        ch.group.children.forEach(child => {
          if (child instanceof THREE.InstancedMesh) {
            // release to pool by type is approximate; we'll clear geometry only if needed
            child.countUsed = 0;
          }
        });
        scene.remove(ch.group);
      }
    } catch(e){}
    // rebuild
    const instanced = buildInstancedForChunk(diff.cx, diff.cz, ch.blocks);
    const group = new THREE.Group();
    Object.keys(instanced).forEach(k => group.add(instanced[k]));
    group.name = ch.group ? ch.group.name : `chunk-${diff.cx}-${diff.cz}`;
    scene.add(group);
    ch.group = group; ch.instanced = instanced;
  }

  function setBlockLocal(cx,cz,x,y,z,block){
    const key = `${cx},${cz}`; const ch = chunks[key]; if (!ch) return false;
    ch.blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x] = block;
    applyChunkDiff({ cx, cz, edits: [{ x,y,z,block }] });
    return true;
  }

  function ensureRemote(id, info) {
    if (!remote[id]) {
      const ent = createCharacterEntity({ color: 0x99ff99, name: info.name, useGLTF: !!gltfPlayer });
      ent.position.set(info.x || 0, (info.y||0)+0.5, info.z || 0);
      entitiesGroup.add(ent);
      remote[id] = { ent, target: { x: ent.position.x, y: ent.position.y, z: ent.position.z }, labelCanvas: ent.userData && ent.userData._labelSprite && ent.userData._labelSprite.material && ent.userData._labelSprite.material.map && ent.userData._labelSprite.material.map.image };
    }
    return remote[id];
  }
  function removeRemote(id) { const r=remote[id]; if(!r) return; entitiesGroup.remove(r.ent); delete remote[id]; }

  function updatePlayers(list){
    const ids = new Set();
    for (const p of list) {
      ids.add(p.id);
      if (p.id === (window.myId || '')) continue;
      const r = ensureRemote(p.id, p);
      r.target.x = p.x || 0; r.target.y = (p.y||0)+0.5; r.target.z = p.z || 0;
      const color = p.role === 'seeker' ? 0xff6666 : (p.type==='bird'?0xffa88a:(p.type==='vehicle'?0x4444ff:0x99ff99));
      r.ent.traverse(o => { if (o.isMesh && o.material) o.material.color.setHex(color); });
      if (r.labelCanvas) {
        const ctx = r.labelCanvas.getContext('2d');
        ctx.clearRect(0,0,r.labelCanvas.width,r.labelCanvas.height);
        ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.font='20px sans-serif'; ctx.textAlign='center'; ctx.fillText(p.name || 'Player', r.labelCanvas.width/2, 42);
        const sprite = r.ent.children.find(c=>c.type==='Sprite');
        if (sprite) sprite.material.map.needsUpdate = true;
      }
    }
    for (const id of Object.keys(remote)) if (!ids.has(id)) removeRemote(id);
  }

  function spawnShotEffect(fromPos, toPos, color=0xffff88){
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.12,8,8), new THREE.MeshStandardMaterial({ color }));
    sphere.position.set(fromPos.x, fromPos.y, fromPos.z);
    scene.add(sphere);
    const dur = 600; const start = Date.now();
    (function tick(){ const t=(Date.now()-start)/dur; if (t>=1){ try{ scene.remove(sphere); sphere.geometry.dispose(); sphere.material.dispose(); }catch(e){} return; } sphere.position.lerpVectors(new THREE.Vector3(fromPos.x,fromPos.y,fromPos.z), new THREE.Vector3(toPos.x,toPos.y,toPos.z), t); requestAnimationFrame(tick); })();
  }
  function animateMuzzleAtEntity(id){ const r=remote[id]; if(!r) return; const flash = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.12,0.12), new THREE.MeshStandardMaterial({ color:0xfff1a8, emissive:0xfff1a8 })); flash.position.set(r.ent.position.x + 0.9, r.ent.position.y + 1.0, r.ent.position.z); scene.add(flash); setTimeout(()=>{ try{ scene.remove(flash); flash.geometry.dispose(); flash.material.dispose(); }catch(e){} }, 120); }

  // third-person controls (mouse-look, WASD/arrow, crouch, left-click shoot)
  function setupControls(){
    const canvas = document.getElementById('gameCanvas');
    const keys = { f:false,b:false,l:false,r:false }; let dash=false;
    function kd(e){ if (e.code==='KeyW'||e.code==='ArrowUp') keys.f=true; if (e.code==='KeyS'||e.code==='ArrowDown') keys.b=true; if (e.code==='KeyA'||e.code==='ArrowLeft') keys.l=true; if (e.code==='KeyD'||e.code==='ArrowRight') keys.r=true; if (e.code==='ControlLeft'||e.code==='KeyC') playerPos.crouch = true; }
    function ku(e){ if (e.code==='KeyW'||e.code==='ArrowUp') keys.f=false; if (e.code==='KeyS'||e.code==='ArrowDown') keys.b=false; if (e.code==='KeyA'||e.code==='ArrowLeft') keys.l=false; if (e.code==='KeyD'||e.code==='ArrowRight') keys.r=false; if (e.code==='ControlLeft'||e.code==='KeyC') playerPos.crouch = false; }
    document.addEventListener('keydown', kd); document.addEventListener('keyup', ku);
    function onMouseMove(e){ const mx=e.movementX||0, my=e.movementY||0; playerYaw -= mx*0.0025; playerPitch = (playerPitch||0) - my*0.0025; playerPitch = Math.max(-Math.PI/3, Math.min(Math.PI/3, playerPitch)); }
    canvas.addEventListener('click', ()=> canvas.requestPointerLock && canvas.requestPointerLock());
    document.addEventListener('pointerlockchange', ()=> { if (document.pointerLockElement === canvas) document.addEventListener('mousemove', onMouseMove); else document.removeEventListener('mousemove', onMouseMove); });
    canvas.addEventListener('mousedown', (e)=> { if (e.button === 0) { if (typeof window.doLocalShoot === 'function') window.doLocalShoot(); } else if (e.button === 2) { dash = true; }});
    canvas.addEventListener('mouseup', (e)=> { if (e.button === 2) dash = false; });
    canvas.addEventListener('contextmenu', (e)=> e.preventDefault());

    function update(dt){
      const speed = playerPos.crouch ? 2.2 : 6;
      const forward = new THREE.Vector3(Math.sin(playerYaw), 0, Math.cos(playerYaw)).normalize();
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), forward).normalize();
      const mv = new THREE.Vector3();
      if (keys.f) mv.addScaledVector(forward, speed*dt);
      if (keys.b) mv.addScaledVector(forward, -speed*dt);
      if (keys.l) mv.addScaledVector(right, -speed*dt);
      if (keys.r) mv.addScaledVector(right, speed*dt);
      if (dash) mv.addScaledVector(forward, speed*dt*1.6);
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

  // initialization: try load assets, then init rendering
  await tryLoadAssets();
  try { initRenderer(); initScene(); setupControls(); console.info('[world] advanced renderer ready (assets loaded:', { gltfLoaded: !!gltfPlayer, atlasLoaded: !!atlasTexture }); } catch (e) { console.error('renderer init failed', e); overlayMessage('Graphics init failed: ' + e.message); }

  window.VoxelWorld = {
    start: ()=>{ return true; },
    requestChunk,
    applyChunkDiff,
    setBlockLocal,
    getPlayerPosition,
    getCamera,
    updatePlayers,
    spawnShotEffect,
    animateMuzzleAtEntity,
    BLOCKS: { AIR:BLOCK_AIR, GRASS, DIRT, STONE, SHIELD, WOOD, LEAF, BUILDING, ROAD, SERUM, BUSH }
  };

  console.info('[world] advanced VoxelWorld available');
})();
