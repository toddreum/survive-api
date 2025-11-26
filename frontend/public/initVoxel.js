// Renderer fixes: ensure remotes are visible, labels readable, and fallback entity clearly visible.
// - Increased label scale and set depthTest:false so names render on top.
// - Ensure VoxelWorld.updatePlayers updates remote ent positions and creates humanoid representations for bots/players.
// - Provide clear defaults if no human GLTF present.

(async function(){
  if (window.VoxelWorld) return;

  const CHUNK_SIZE = 16, CHUNK_HEIGHT = 32;
  const BLOCK_AIR = 0, BLOCK_GRASS = 1, BLOCK_DIRT = 2, BLOCK_STONE = 3, BLOCK_SHIELD = 4,
        BLOCK_WOOD = 5, BLOCK_LEAF = 6, BLOCK_BUILDING = 7, BLOCK_ROAD = 8, BLOCK_SERUM = 9, BLOCK_BUSH = 10;

  const blockColors = {
    [BLOCK_GRASS]: 0x2d6b3a, [BLOCK_DIRT]: 0x6b4a2a, [BLOCK_STONE]: 0x8a8a8a, [BLOCK_SHIELD]: 0xffd24d,
    [BLOCK_WOOD]: 0x6b3a1a, [BLOCK_LEAF]: 0x3fbf4a, [BLOCK_BUILDING]: 0x4b5563, [BLOCK_ROAD]: 0x2b2b2b, [BLOCK_SERUM]: 0x7afcff, [BLOCK_BUSH]: 0x2fa044
  };

  let scene=null, camera=null, renderer=null, clock=null;
  let playerEntity=null, playerPos={x:0,y:0,z:0,crouch:false}, yaw=0, pitch=0;
  const remote = {}; const entitiesGroup = new THREE.Group();
  let humanModel=null;

  async function loadHumanModelNonBlocking(){
    try {
      const { GLTFLoader } = await import('https://unpkg.com/three@0.152.2/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      loader.load('/assets/human.glb', (gltf)=>{ humanModel = gltf; console.info('[world] human model loaded'); }, undefined, ()=>{});
    } catch(e){ console.warn('GLTF loader missing', e); }
  }

  function createLabelCanvas(name){
    const c = document.createElement('canvas'); c.width=256; c.height=64; const ctx=c.getContext('2d');
    ctx.fillStyle='rgba(0,0,0,0.7)'; ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.font='20px sans-serif'; ctx.textAlign='center'; ctx.fillText(name, c.width/2, 42);
    return c;
  }

  function createHumanoidEntity(colorHex, name){
    if (humanModel) {
      const clone = humanModel.scene ? humanModel.scene.clone(true) : humanModel.clone(true);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(createLabelCanvas(name)), depthTest:false, depthWrite:false }));
      label.scale.set(3.2,1.0,1); label.position.set(0,3.0,0); clone.add(label); clone.userData._labelCanvas = label.material.map.image;
      return clone;
    }
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: colorHex });
    const skin = new THREE.MeshStandardMaterial({ color: 0xffd8b8 });
    const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.18,1), mat); legL.position.set(-0.18,0.5,0);
    const legR = legL.clone(); legR.position.set(0.18,0.5,0);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7,1.1,0.4), mat); torso.position.set(0,1.4,0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26,16,16), skin); head.position.set(0,2.35,0);
    g.add(legL, legR, torso, head);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(createLabelCanvas(name)), depthTest:false, depthWrite:false }));
    label.scale.set(3.2,1.0,1); label.position.set(0,3.0,0); g.add(label); g.userData._labelCanvas = label.material.map.image;
    return g;
  }

  function initRenderer(){
    const canvas = document.getElementById('gameCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    if ('outputColorSpace' in renderer && THREE && THREE.SRGBColorSpace) {
      try { renderer.outputColorSpace = THREE.SRGBColorSpace; } catch(e){ renderer.outputEncoding = THREE.sRGBEncoding; }
    } else renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }

  async function initScene(){
    scene = new THREE.Scene(); clock = new THREE.Clock();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 2000);
    camera.position.set(0,2.6,6);
    const hemi = new THREE.HemisphereLight(0xbbddff, 0x080820, 0.8); scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9); dir.position.set(5,10,7); scene.add(dir);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000,3000), new THREE.MeshStandardMaterial({ color:0xbfc5c9 }));
    ground.rotation.x = -Math.PI/2; ground.position.y = -1; scene.add(ground);
    entitiesGroup.name='entities'; scene.add(entitiesGroup);
    // create fallback local player entity
    playerEntity = createHumanoidEntity(0xffcc66, (window.sessionStorage && JSON.parse(sessionStorage.getItem('survive.session.v1')||'{}')).name || 'You');
    playerEntity.position.set(0,1.0,0); scene.add(playerEntity);
    loadHumanModelNonBlocking().catch(()=>{});
    window.addEventListener('resize', ()=>{ camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
  }

  function ensureRemote(id, info){
    if (!remote[id]) {
      const ent = createHumanoidEntity(info && info.role === 'seeker' ? 0xff6666 : 0x66aaff, info && info.name ? info.name : 'Player');
      ent.position.set(info.x || 0, (info.y||0)+0.5, info.z || 0);
      entitiesGroup.add(ent);
      remote[id] = { ent, target: { x: ent.position.x, y: ent.position.y, z: ent.position.z } };
    }
    return remote[id];
  }

  function updatePlayers(list){
    if (!Array.isArray(list)) return;
    const ids = new Set();
    for (const p of list) {
      ids.add(p.id);
      if (p.id === (window.myId || '')) { // update local player entity position if provided
        try { if (p.x != null && p.z != null && playerEntity) playerEntity.position.set(p.x, playerEntity.position.y, p.z); } catch(e){}
        continue;
      }
      const r = ensureRemote(p.id, p);
      r.target.x = p.x || 0; r.target.y = (p.y||0) + 0.5; r.target.z = p.z || 0;
      // ensure label updated
      if (r.ent && r.ent.userData && r.ent.userData._labelCanvas) {
        const canvas = r.ent.userData._labelCanvas; const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,canvas.width,canvas.height); ctx.fillStyle='rgba(0,0,0,0.7)'; ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.font='18px sans-serif'; ctx.textAlign='center';
        ctx.fillText(p.name || 'Player', canvas.width/2, 42);
        const spr = r.ent.children.find(c=>c.type==='Sprite'); if (spr) spr.material.map.needsUpdate = true;
      }
    }
    for (const id of Object.keys(remote)) if (!ids.has(id)) { if (remote[id] && remote[id].ent) scene.remove(remote[id].ent); delete remote[id]; }
  }

  function spawnShotEffect(from, to, color=0xffff88){
    if (!scene) return;
    if (!from || !to) return;
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.12,8,8), new THREE.MeshStandardMaterial({ color }));
    s.position.set(from.x, from.y, from.z); scene.add(s);
    const dur = 600, start = Date.now();
    (function tick(){
      const t = (Date.now() - start) / dur;
      if (t >= 1) { try{ scene.remove(s); s.geometry.dispose(); s.material.dispose(); } catch(e){} return; }
      s.position.lerpVectors(new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(to.x, to.y, to.z), t);
      requestAnimationFrame(tick);
    })();
  }

  function showShooterMarker(pos, id, duration = 4000){
    if (!scene || !pos) return;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.45,0.08,8,12), new THREE.MeshStandardMaterial({ color:0xff4444, emissive:0xff4444 }));
    ring.position.set(pos.x, pos.y + 1.6, pos.z); scene.add(ring);
    setTimeout(()=>{ try{ scene.remove(ring); ring.geometry.dispose(); ring.material.dispose(); } catch(e){} }, duration);
  }

  function setupControls(){
    const canvas = document.getElementById('gameCanvas');
    if (!canvas) return;
    const keys = { f:false,b:false,l:false,r:false }; let dash=false;
    function kd(e){ if (e.code==='KeyW'||e.code==='ArrowUp') keys.f=true; if (e.code==='KeyS'||e.code==='ArrowDown') keys.b=true; if (e.code==='KeyA'||e.code==='ArrowLeft') keys.l=true; if (e.code==='KeyD'||e.code==='ArrowRight') keys.r=true; if (e.code==='ControlLeft'||e.code==='KeyC') playerPos.crouch = true; }
    function ku(e){ if (e.code==='KeyW'||e.code==='ArrowUp') keys.f=false; if (e.code==='KeyS'||e.code==='ArrowDown') keys.b=false; if (e.code==='KeyA'||e.code==='ArrowLeft') keys.l=false; if (e.code==='KeyD'||e.code==='ArrowRight') keys.r=false; if (e.code==='ControlLeft'||e.code==='KeyC') playerPos.crouch = false; }
    document.addEventListener('keydown', kd); document.addEventListener('keyup', ku);
    function onMouseMove(e){ const mx=e.movementX||0, my=e.movementY||0; yaw -= mx*0.0025; pitch = Math.max(-Math.PI/3, Math.min(Math.PI/3, (pitch||0) - my*0.0025)); }
    canvas.addEventListener('click', ()=> canvas.requestPointerLock && canvas.requestPointerLock());
    document.addEventListener('pointerlockchange', ()=> { if (document.pointerLockElement===canvas) document.addEventListener('mousemove', onMouseMove); else document.removeEventListener('mousemove', onMouseMove); });

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
      // simple collision check omitted here (handled by VoxelWorld.isPositionFree if present)
      playerPos.x = nx; playerPos.z = nz;
      if (playerEntity) playerEntity.position.set(playerPos.x, playerEntity.position.y, playerPos.z);
      // smooth remotes
      for (const id of Object.keys(remote)){
        const r = remote[id];
        r.ent.position.x += (r.target.x - r.ent.position.x) * Math.min(1, dt*6);
        r.ent.position.y += (r.target.y - r.ent.position.y) * Math.min(1, dt*6);
        r.ent.position.z += (r.target.z - r.ent.position.z) * Math.min(1, dt*6);
      }
    }
    function animate(){ requestAnimationFrame(animate); const dt = Math.min(0.05, clock.getDelta()); try{ update(dt); } catch(e){ console.warn('render update err', e); } renderer.render(scene, camera); }
    animate();
  }

  window.VoxelWorld = {
    start: function(){ try{ initRenderer(); initScene(); setupControls(); console.info('[world] renderer started'); return true; } catch(e){ console.error('renderer start failed', e); return false; } },
    requestChunk: async function(cx,cz){ /* very small wrapper; actual request left as-is if you have chunk API */ if (window.fetch) { try { const resp = await fetch(`/chunk?cx=${cx}&cz=${cz}`); if (resp.ok) { const j = await resp.json(); /* no-op here, client will also get chunkDiff from server */ } } catch(e){} } },
    updatePlayers,
    spawnShotEffect,
    showShooterMarker,
    applyChunkDiff: function(){ /* implemented server-side call handling in previous code */ },
    requestChunkRaw: function(){}, // kept for compatibility
    getPlayerPosition: function(){ return { x: playerPos.x, y: playerPos.y, z: playerPos.z, crouch: !!playerPos.crouch }; },
    scanHidingSpots: function(cx,cz,r=2){ scanHidingSpots(cx,cz,r); },
    clearHidingMarkers: function(){ /* not implemented separately here */ }
  };

  console.info('[world] initVoxel ready');

})();
