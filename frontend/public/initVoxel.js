// frontend/public/initVoxel.js
// Chunked voxel renderer with greedy meshing, first-person controls, block placement/removal

(function() {
  'use strict';

  if (typeof THREE === 'undefined') {
    console.error('THREE.js not loaded; cannot init voxel renderer');
    return;
  }

  const CHUNK_SIZE = 16;
  const BLOCK_SIZE = 1;
  const RENDER_DISTANCE = 4; // chunks

  let scene, camera, renderer;
  let controls = { forward: false, backward: false, left: false, right: false, jump: false };
  let velocity = { x: 0, y: 0, z: 0 };
  let playerPosition = { x: 0, y: 5, z: 0 };
  let isGrounded = false;
  let mouseLocked = false;
  let yaw = 0, pitch = 0;

  const chunks = new Map(); // key: "cx,cz" -> chunk mesh
  const chunkData = new Map(); // key: "cx,cz" -> { blocks: [...] }

  let selectedBlockType = 1; // default: grass
  const hotbar = [1, 2, 3, 4, 5]; // block types in hotbar
  let hotbarIndex = 0;

  // Texture atlas (placeholder)
  let textureAtlas = null;
  const ATLAS_SIZE = 256;
  const TILE_SIZE = 16;
  const TILES_PER_ROW = ATLAS_SIZE / TILE_SIZE;

  // Block type to atlas tile mapping (placeholder)
  const blockTiles = {
    0: null, // air
    1: { top: 0, side: 1, bottom: 2 }, // grass
    2: { all: 3 }, // dirt
    3: { all: 4 }, // stone
    4: { all: 5 }, // wood
    5: { all: 6 }  // brick
  };

  // Initialize voxel world
  window.initVoxel = function() {
    if (!scene) {
      setupScene();
      setupControls();
      setupHotbar();
      loadTextureAtlas();
      animate();
    }
  };

  function setupScene() {
    const canvas = document.getElementById('gameCanvas');
    if (!canvas) {
      console.error('gameCanvas not found');
      return;
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // sky blue
    scene.fog = new THREE.Fog(0x87CEEB, 10, RENDER_DISTANCE * CHUNK_SIZE * BLOCK_SIZE);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(playerPosition.x, playerPosition.y, playerPosition.z);

    renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    // Ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    // Directional light (sun)
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(50, 100, 50);
    scene.add(dirLight);

    // Handle window resize
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  function setupControls() {
    const canvas = document.getElementById('gameCanvas');

    // Pointer lock
    canvas.addEventListener('click', () => {
      canvas.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
      mouseLocked = document.pointerLockElement === canvas;
    });

    // Mouse movement
    document.addEventListener('mousemove', (e) => {
      if (!mouseLocked) return;
      const sensitivity = 0.002;
      yaw -= e.movementX * sensitivity;
      pitch -= e.movementY * sensitivity;
      pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      switch (e.code) {
        case 'KeyW': controls.forward = true; break;
        case 'KeyS': controls.backward = true; break;
        case 'KeyA': controls.left = true; break;
        case 'KeyD': controls.right = true; break;
        case 'Space': controls.jump = true; break;
        case 'Digit1': selectHotbarSlot(0); break;
        case 'Digit2': selectHotbarSlot(1); break;
        case 'Digit3': selectHotbarSlot(2); break;
        case 'Digit4': selectHotbarSlot(3); break;
        case 'Digit5': selectHotbarSlot(4); break;
      }
    });

    document.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW': controls.forward = false; break;
        case 'KeyS': controls.backward = false; break;
        case 'KeyA': controls.left = false; break;
        case 'KeyD': controls.right = false; break;
        case 'Space': controls.jump = false; break;
      }
    });

    // Mouse click for block placement/removal
    document.addEventListener('mousedown', (e) => {
      if (!mouseLocked) return;
      if (e.button === 0) {
        // Left click: remove block
        removeBlock();
      } else if (e.button === 2) {
        // Right click: place block
        placeBlock();
      }
    });

    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  }

  function setupHotbar() {
    const hotbarEl = document.getElementById('hotbar');
    if (!hotbarEl) {
      // Create hotbar
      const hb = document.createElement('div');
      hb.id = 'hotbar';
      hb.style.cssText = 'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); display:flex; gap:8px; z-index:100;';
      document.body.appendChild(hb);

      hotbar.forEach((type, i) => {
        const slot = document.createElement('div');
        slot.className = 'hotbar-slot';
        slot.style.cssText = 'width:48px; height:48px; background:rgba(0,0,0,0.5); border:2px solid rgba(255,255,255,0.3); display:flex; align-items:center; justify-content:center; color:#fff; font-weight:bold; cursor:pointer; border-radius:4px;';
        slot.textContent = type;
        slot.dataset.index = i;
        if (i === hotbarIndex) slot.style.borderColor = '#f97316';
        slot.addEventListener('click', () => selectHotbarSlot(i));
        hb.appendChild(slot);
      });
    }
  }

  function selectHotbarSlot(index) {
    if (index < 0 || index >= hotbar.length) return;
    hotbarIndex = index;
    selectedBlockType = hotbar[index];
    // Update UI
    document.querySelectorAll('.hotbar-slot').forEach((slot, i) => {
      slot.style.borderColor = (i === hotbarIndex) ? '#f97316' : 'rgba(255,255,255,0.3)';
    });
  }

  function loadTextureAtlas() {
    const loader = new THREE.TextureLoader();
    loader.load('/textures/atlas.png', (texture) => {
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      textureAtlas = texture;
      console.log('Texture atlas loaded');
      // Request initial chunks
      requestInitialChunks();
    }, undefined, (err) => {
      console.warn('Failed to load texture atlas, using default material', err);
      // Request initial chunks anyway
      requestInitialChunks();
    });
  }

  function requestInitialChunks() {
    const px = Math.floor(playerPosition.x / (CHUNK_SIZE * BLOCK_SIZE));
    const pz = Math.floor(playerPosition.z / (CHUNK_SIZE * BLOCK_SIZE));

    for (let cx = px - RENDER_DISTANCE; cx <= px + RENDER_DISTANCE; cx++) {
      for (let cz = pz - RENDER_DISTANCE; cz <= pz + RENDER_DISTANCE; cz++) {
        requestChunk(cx, cz);
      }
    }
  }

  function requestChunk(cx, cz) {
    const key = `${cx},${cz}`;
    if (chunkData.has(key)) return;

    // Request from server
    if (typeof window.socket !== 'undefined' && window.socket && window.socket.connected) {
      window.socket.emit('chunkRequest', { cx, cz });
    }
  }

  // Receive chunk data from server
  if (typeof window !== 'undefined') {
    window.onChunkData = function(chunk) {
      const key = `${chunk.cx},${chunk.cz}`;
      chunkData.set(key, chunk);
      updateChunkMesh(chunk.cx, chunk.cz);
    };
  }

  function updateChunkMesh(cx, cz) {
    const key = `${cx},${cz}`;
    const data = chunkData.get(key);
    if (!data) return;

    // Remove old mesh
    const oldMesh = chunks.get(key);
    if (oldMesh) {
      scene.remove(oldMesh);
      if (oldMesh.geometry) oldMesh.geometry.dispose();
      if (oldMesh.material) {
        if (Array.isArray(oldMesh.material)) {
          oldMesh.material.forEach(m => m.dispose());
        } else {
          oldMesh.material.dispose();
        }
      }
    }

    // Build new mesh with greedy meshing
    const geometry = buildChunkGeometry(data);
    if (!geometry) return;

    const material = textureAtlas
      ? new THREE.MeshLambertMaterial({ map: textureAtlas })
      : new THREE.MeshLambertMaterial({ color: 0x00ff00 });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cx * CHUNK_SIZE * BLOCK_SIZE, 0, cz * CHUNK_SIZE * BLOCK_SIZE);
    scene.add(mesh);
    chunks.set(key, mesh);
  }

  // Greedy meshing algorithm (simplified)
  function buildChunkGeometry(chunk) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    let vertexCount = 0;

    const blockMap = new Map();
    chunk.blocks.forEach(b => {
      blockMap.set(`${b.x},${b.y},${b.z}`, b.type);
    });

    function getBlock(x, y, z) {
      return blockMap.get(`${x},${y},${z}`) || 0;
    }

    // For each block, check 6 faces
    chunk.blocks.forEach(b => {
      const { x, y, z, type } = b;
      if (type === 0) return; // air

      const wx = x * BLOCK_SIZE;
      const wy = y * BLOCK_SIZE;
      const wz = z * BLOCK_SIZE;

      const tile = blockTiles[type] || blockTiles[1];

      // Check each face
      const faces = [
        { dir: [0, 1, 0], corners: [[0,1,0],[1,1,0],[1,1,1],[0,1,1]], check: [x, y+1, z], tileSide: 'top' }, // top
        { dir: [0,-1, 0], corners: [[0,0,1],[1,0,1],[1,0,0],[0,0,0]], check: [x, y-1, z], tileSide: 'bottom' }, // bottom
        { dir: [1, 0, 0], corners: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]], check: [x+1, y, z], tileSide: 'side' }, // right
        { dir: [-1,0, 0], corners: [[0,0,1],[0,1,1],[0,1,0],[0,0,0]], check: [x-1, y, z], tileSide: 'side' }, // left
        { dir: [0, 0, 1], corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], check: [x, y, z+1], tileSide: 'side' }, // front
        { dir: [0, 0,-1], corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], check: [x, y, z-1], tileSide: 'side' }  // back
      ];

      faces.forEach(face => {
        const [nx, ny, nz] = face.check;
        const neighbor = getBlock(nx, ny, nz);
        if (neighbor !== 0) return; // face is hidden

        const tileIndex = tile.all !== undefined ? tile.all : (tile[face.tileSide] !== undefined ? tile[face.tileSide] : 0);
        const u0 = (tileIndex % TILES_PER_ROW) * (TILE_SIZE / ATLAS_SIZE);
        const v0 = Math.floor(tileIndex / TILES_PER_ROW) * (TILE_SIZE / ATLAS_SIZE);
        const u1 = u0 + (TILE_SIZE / ATLAS_SIZE);
        const v1 = v0 + (TILE_SIZE / ATLAS_SIZE);

        const faceUVs = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]];

        // Add 4 vertices
        face.corners.forEach((corner, i) => {
          positions.push(wx + corner[0] * BLOCK_SIZE, wy + corner[1] * BLOCK_SIZE, wz + corner[2] * BLOCK_SIZE);
          normals.push(face.dir[0], face.dir[1], face.dir[2]);
          uvs.push(faceUVs[i][0], faceUVs[i][1]);
        });

        // Add 2 triangles
        indices.push(vertexCount, vertexCount + 1, vertexCount + 2);
        indices.push(vertexCount, vertexCount + 2, vertexCount + 3);
        vertexCount += 4;
      });
    });

    if (positions.length === 0) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
  }

  function animate() {
    requestAnimationFrame(animate);

    // Update player movement
    updatePlayerMovement();

    // Update camera
    camera.position.set(playerPosition.x, playerPosition.y, playerPosition.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;

    // Render
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }

  function updatePlayerMovement() {
    const delta = 0.016; // ~60fps
    const speed = 5;
    const jumpSpeed = 8;
    const gravity = -20;

    // Apply gravity
    velocity.y += gravity * delta;

    // Ground collision (simple: y <= 1)
    if (playerPosition.y <= 1) {
      playerPosition.y = 1;
      velocity.y = 0;
      isGrounded = true;
    } else {
      isGrounded = false;
    }

    // Jump
    if (controls.jump && isGrounded) {
      velocity.y = jumpSpeed;
      isGrounded = false;
    }

    // Horizontal movement
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

    if (controls.forward) {
      playerPosition.x += forward.x * speed * delta;
      playerPosition.z += forward.z * speed * delta;
    }
    if (controls.backward) {
      playerPosition.x -= forward.x * speed * delta;
      playerPosition.z -= forward.z * speed * delta;
    }
    if (controls.left) {
      playerPosition.x -= right.x * speed * delta;
      playerPosition.z -= right.z * speed * delta;
    }
    if (controls.right) {
      playerPosition.x += right.x * speed * delta;
      playerPosition.z += right.z * speed * delta;
    }

    playerPosition.y += velocity.y * delta;
  }

  // Block placement
  function placeBlock() {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

    // Cast ray to find block face
    const intersects = raycaster.intersectObjects(Array.from(chunks.values()));
    if (intersects.length === 0) return;

    const hit = intersects[0];
    const normal = hit.face.normal;

    // Place block adjacent to hit face
    const placePos = hit.point.clone().add(normal.multiplyScalar(0.5));
    const bx = Math.floor(placePos.x / BLOCK_SIZE);
    const by = Math.floor(placePos.y / BLOCK_SIZE);
    const bz = Math.floor(placePos.z / BLOCK_SIZE);

    const cx = Math.floor(bx / CHUNK_SIZE);
    const cz = Math.floor(bz / CHUNK_SIZE);
    const lx = bx - cx * CHUNK_SIZE;
    const lz = bz - cz * CHUNK_SIZE;

    // Add to local chunk data
    const key = `${cx},${cz}`;
    let chunk = chunkData.get(key);
    if (!chunk) {
      chunk = { cx, cz, blocks: [] };
      chunkData.set(key, chunk);
    }
    chunk.blocks.push({ x: lx, y: by, z: lz, type: selectedBlockType });
    updateChunkMesh(cx, cz);

    // Send to server
    if (typeof window.socket !== 'undefined' && window.socket && window.socket.connected) {
      window.socket.emit('blockPlace', { cx, cz, x: lx, y: by, z: lz, type: selectedBlockType });
    }
  }

  function removeBlock() {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

    const intersects = raycaster.intersectObjects(Array.from(chunks.values()));
    if (intersects.length === 0) return;

    const hit = intersects[0];
    const removePos = hit.point.clone().sub(hit.face.normal.multiplyScalar(0.5));
    const bx = Math.floor(removePos.x / BLOCK_SIZE);
    const by = Math.floor(removePos.y / BLOCK_SIZE);
    const bz = Math.floor(removePos.z / BLOCK_SIZE);

    const cx = Math.floor(bx / CHUNK_SIZE);
    const cz = Math.floor(bz / CHUNK_SIZE);
    const lx = bx - cx * CHUNK_SIZE;
    const lz = bz - cz * CHUNK_SIZE;

    // Remove from local chunk data
    const key = `${cx},${cz}`;
    const chunk = chunkData.get(key);
    if (!chunk) return;
    chunk.blocks = chunk.blocks.filter(b => !(b.x === lx && b.y === by && b.z === lz));
    updateChunkMesh(cx, cz);

    // Send to server
    if (typeof window.socket !== 'undefined' && window.socket && window.socket.connected) {
      window.socket.emit('blockRemove', { cx, cz, x: lx, y: by, z: lz });
    }
  }

  // Expose player position getter for game.js
  window.getPlayerPosition = function() {
    return { x: playerPosition.x, y: playerPosition.y, z: playerPosition.z };
  };

  // Listen for block updates from server
  if (typeof window.socket !== 'undefined' && window.socket) {
    window.socket.on('blockUpdate', (data) => {
      const { cx, cz, x, y, z, type, action } = data;
      const key = `${cx},${cz}`;
      let chunk = chunkData.get(key);
      if (!chunk) {
        chunk = { cx, cz, blocks: [] };
        chunkData.set(key, chunk);
      }

      if (action === 'place') {
        chunk.blocks.push({ x, y, z, type });
      } else if (action === 'remove') {
        chunk.blocks = chunk.blocks.filter(b => !(b.x === x && b.y === y && b.z === z));
      }

      updateChunkMesh(cx, cz);
    });
  }

})();
