// frontend/public/initVoxel.js
// Robust voxel initializer — checks for THREE and WebGL, logs errors, and provides a friendly fallback UI.

(function(){
  if (window.VoxelWorld) return;

  const CHUNK_SIZE = 16, CHUNK_HEIGHT = 32;
  const BLOCK_AIR = 0, BLOCK_GRASS = 1, BLOCK_DIRT = 2, BLOCK_STONE = 3, BLOCK_SHIELD = 4;
  const blockColors = { [BLOCK_GRASS]: 0x4CAF50, [BLOCK_DIRT]: 0x8B5A2B, [BLOCK_STONE]: 0x8A8A8A, [BLOCK_SHIELD]: 0xFFD700 };

  let scene, camera, renderer, clock, playerMesh;
  const chunks = {}; // key -> { group, blocks, cx, cz }

  function overlayMessage(text) {
    let o = document.getElementById('voxelErrorOverlay');
    if (!o) {
      o = document.createElement('div');
      o.id = 'voxelErrorOverlay';
      Object.assign(o.style, {
        position: 'fixed', inset: '0', display:'flex', alignItems:'center', justifyContent:'center',
        background: 'rgba(0,0,0,0.6)', color: '#fff', zIndex: 9999, fontSize: '18px', textAlign:'center', padding:'24px'
      });
      document.body.appendChild(o);
    }
    o.textContent = text;
    o.style.display = 'flex';
  }

  function hideOverlay() {
    const o = document.getElementById('voxelErrorOverlay');
    if (o) o.style.display = 'none';
  }

  function canUseWebGL() {
    try {
      const canvas = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
    } catch (e) {
      return false;
    }
  }

  function initRenderer() {
    if (typeof THREE === 'undefined') {
      throw new Error('three.js not found (THREE is undefined). Check script tag order and CDN.');
    }
    if (!canUseWebGL()) {
      throw new Error('WebGL not available in this browser.');
    }
    const canvas = document.getElementById('gameCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.setClearColor(0x000000, 1);
  }

  function initScene() {
    scene = new THREE.Scene();
    clock = new THREE.Clock();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
    camera.position.set(0,4,8);

    const hemi = new THREE.HemisphereLight(0xbfe6ff, 0x080820, 0.6); scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9); dir.position.set(5,10,7); scene.add(dir);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200,200), new THREE.MeshStandardMaterial({ color:0x071022 }));
    ground.rotation.x = -Math.PI/2; ground.position.y = 0; scene.add(ground);

    const geo = new THREE.CapsuleGeometry(0.4,1.2,4,8);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffcc66 });
    playerMesh = new THREE.Mesh(geo, mat); playerMesh.position.set(0,1.6,0); scene.add(playerMesh);

    window.addEventListener('resize', onResize);
    onResize();
  }

  function onResize(){
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // create instanced chunk group
  function createChunkGroup(cx,cz, blocks) {
    const group = new THREE.Group();
    const box = new THREE.BoxGeometry(1,1,1);
    const types = {};
    for (let x=0;x<CHUNK_SIZE;x++){
      for (let z=0;z<CHUNK_SIZE;z++){
        for (let y=0;y<CHUNK_HEIGHT;y++){
          const v = blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x];
          if (v && v !== BLOCK_AIR) {
            if (!types[v]) types[v] = [];
            types[v].push({ x: cx*CHUNK_SIZE + x + 0.5, y: y + 0.5, z: cz*CHUNK_SIZE + z + 0.5 });
          }
        }
      }
    }
    Object.keys(types).forEach(k => {
      const places = types[k];
      const mat = new THREE.MeshStandardMaterial({ color: blockColors[k] || 0xffffff });
      const inst = new THREE.InstancedMesh(box, mat, places.length);
      const dummy = new THREE.Object3D();
      let i=0;
      for (const p of places) { dummy.position.set(p.x,p.y,p.z); dummy.updateMatrix(); inst.setMatrixAt(i++, dummy.matrix); }
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
    });
    return group;
  }

  async function requestChunk(cx,cz) {
    const key = `${cx},${cz}`; if (chunks[key]) return;
    try {
      const resp = await fetch(`/chunk?cx=${cx}&cz=${cz}`);
      if (!resp.ok) throw new Error('chunk request failed: ' + resp.status);
      const j = await resp.json();
      if (!j.ok) throw new Error('chunk response ok:false');
      const group = createChunkGroup(cx,cz, j.blocks);
      group.name = `chunk-${cx}-${cz}`;
      scene.add(group);
      chunks[key] = { group, blocks: j.blocks, cx, cz };
      console.info('[voxel] chunk loaded', cx, cz);
    } catch (e) {
      console.warn('[voxel] requestChunk failed', e);
      overlayMessage('Could not load chunk data. Check server connectivity. ' + e.message);
      setTimeout(()=> hideOverlay(), 4500);
    }
  }

  function applyChunkDiff(diff) {
    const key = `${diff.cx},${diff.cz}`; const ch = chunks[key];
    if (!ch) return;
    for (const e of diff.edits) { ch.blocks[(e.y*CHUNK_SIZE + e.z)*CHUNK_SIZE + e.x] = e.block; }
    scene.remove(ch.group);
    const newGroup = createChunkGroup(diff.cx,diff.cz,ch.blocks);
    newGroup.name = ch.group.name; scene.add(newGroup); ch.group = newGroup;
  }

  function setBlockLocal(cx,cz,x,y,z,block) {
    const key = `${cx},${cz}`; const ch = chunks[key]; if (!ch) return false;
    ch.blocks[(y*CHUNK_SIZE + z)*CHUNK_SIZE + x] = block;
    scene.remove(ch.group); ch.group = createChunkGroup(cx,cz,ch.blocks); scene.add(ch.group);
    return true;
  }

  function setupControls() {
    const canvas = document.getElementById('gameCanvas');
    const move = { f:false,b:false,l:false,r:false };
    let yaw = 0, pitch = 0;
    document.addEventListener('keydown', (e)=>{ if (e.code==='KeyW') move.f=true; if (e.code==='KeyS') move.b=true; if (e.code==='KeyA') move.l=true; if (e.code==='KeyD') move.r=true; });
    document.addEventListener('keyup', (e)=>{ if (e.code==='KeyW') move.f=false; if (e.code==='KeyS') move.b=false; if (e.code==='KeyA') move.l=false; if (e.code==='KeyD') move.r=false; });
    canvas.addEventListener('click', ()=> canvas.requestPointerLock && canvas.requestPointerLock());
    function onMouseMove(e){ const mx = e.movementX || 0, my = e.movementY || 0; yaw -= mx*0.002; pitch -= my*0.002; pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, pitch)); camera.rotation.set(pitch,yaw,0); }
    document.addEventListener('pointerlockchange', ()=>{ if (document.pointerLockElement===canvas) document.addEventListener('mousemove', onMouseMove); else document.removeEventListener('mousemove', onMouseMove); });
    function update(dt){ const speed = 6; const dir = new THREE.Vector3(); camera.getWorldDirection(dir); dir.y = 0; dir.normalize(); const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), dir).normalize(); const mv = new THREE.Vector3(); if (move.f) mv.addScaledVector(dir, speed*dt); if (move.b) mv.addScaledVector(dir, -speed*dt); if (move.l) mv.addScaledVector(right, -speed*dt); if (move.r) mv.addScaledVector(right, speed*dt); camera.position.add(mv); playerMesh.position.copy(camera.position); playerMesh.position.y = 1.6; }
    function animate(){ requestAnimationFrame(animate); const dt = Math.min(0.05, clock.getDelta()); update(dt); renderer.render(scene,camera); }
    animate();
  }

  function start() {
    try {
      console.info('[voxel] starting...');
      hideOverlay();
      initRenderer();
      initScene();
      setupControls();
      console.info('[voxel] initialized successfully');
      return true;
    } catch (err) {
      console.error('[voxel] initialization failed:', err);
      overlayMessage('Graphics initialization failed — ' + err.message + '. Try a different browser or check server console.');
      return false;
    }
  }

  window.VoxelWorld = {
    start,
    requestChunk,
    applyChunkDiff,
    setBlockLocal,
    getPlayerPosition: ()=> camera ? { x: camera.position.x, y: camera.position.y, z: camera.position.z } : {x:0,y:0,z:0},
    BLOCKS: { AIR:BLOCK_AIR, GRASS:BLOCK_GRASS, DIRT:BLOCK_DIRT, STONE:BLOCK_STONE, SHIELD:BLOCK_SHIELD }
  };

  console.info('[voxel] script loaded; VoxelWorld API available');
})();
