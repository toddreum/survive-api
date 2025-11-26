// frontend/public/initThree.js
// Lightweight three.js initialization helper
// Creates renderer, scene, lighting, ground, and basic postprocessing
// Provides API to load glTF models (placeholder models can be used)
// Safe if three.js is absent (no crash)

(function() {
  'use strict';

  // Check if THREE is available
  if (typeof THREE === 'undefined') {
    console.warn('[initThree] THREE.js not loaded - skipping 3D initialization');
    window.initThree = function() {
      console.warn('[initThree] THREE.js not available');
    };
    return;
  }

  let renderer, scene, camera, pmremGenerator;
  let animationFrameId = null;
  let isInitialized = false;

  // API to expose
  window.initThree = function() {
    if (isInitialized) {
      console.log('[initThree] already initialized');
      return;
    }

    try {
      console.log('[initThree] initializing three.js scene');

      const canvas = document.getElementById('gameCanvas');
      if (!canvas) {
        console.warn('[initThree] gameCanvas not found');
        return;
      }

      // Renderer
      renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: false
      });
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x020617, 1);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;

      // Scene
      scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0x020617, 10, 100);

      // Camera
      camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        1000
      );
      camera.position.set(0, 5, 10);
      camera.lookAt(0, 0, 0);

      // PMREM Environment (for better reflections)
      pmremGenerator = new THREE.PMREMGenerator(renderer);
      pmremGenerator.compileEquirectangularShader();

      // Ambient light
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
      scene.add(ambientLight);

      // Directional light (main sun)
      const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
      dirLight.position.set(10, 20, 10);
      dirLight.castShadow = true;
      dirLight.shadow.camera.left = -30;
      dirLight.shadow.camera.right = 30;
      dirLight.shadow.camera.top = 30;
      dirLight.shadow.camera.bottom = -30;
      dirLight.shadow.camera.near = 0.1;
      dirLight.shadow.camera.far = 100;
      dirLight.shadow.mapSize.width = 2048;
      dirLight.shadow.mapSize.height = 2048;
      scene.add(dirLight);

      // Ground plane
      const groundGeometry = new THREE.PlaneGeometry(100, 100);
      const groundMaterial = new THREE.MeshStandardMaterial({
        color: 0x0a0e19,
        roughness: 0.8,
        metalness: 0.2
      });
      const ground = new THREE.Mesh(groundGeometry, groundMaterial);
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);

      // Add some placeholder cubes for visual interest
      addPlaceholderObjects();

      // Handle window resize
      window.addEventListener('resize', onWindowResize, false);

      // Start animation loop
      animate();

      isInitialized = true;
      console.log('[initThree] initialization complete');

      // Expose useful functions
      window.threeAPI = {
        scene: scene,
        camera: camera,
        renderer: renderer,
        loadModel: loadModel,
        setPlayerPosition: setPlayerPosition,
        getPlayerPosition: getPlayerPosition
      };

    } catch (err) {
      console.error('[initThree] initialization failed', err);
    }
  };

  function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  function animate() {
    animationFrameId = requestAnimationFrame(animate);
    
    if (renderer && scene && camera) {
      // Simple camera orbit for demo
      const time = Date.now() * 0.0001;
      camera.position.x = Math.sin(time) * 15;
      camera.position.z = Math.cos(time) * 15;
      camera.position.y = 5 + Math.sin(time * 0.5) * 2;
      camera.lookAt(0, 0, 0);
      
      renderer.render(scene, camera);
    }
  }

  function addPlaceholderObjects() {
    // Add some colorful cubes as placeholder objects
    const colors = [0xf97316, 0xfacc15, 0x06b6d4, 0x8b5cf6, 0xec4899];
    
    for (let i = 0; i < 5; i++) {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshStandardMaterial({
        color: colors[i % colors.length],
        roughness: 0.4,
        metalness: 0.6,
        emissive: colors[i % colors.length],
        emissiveIntensity: 0.2
      });
      const cube = new THREE.Mesh(geometry, material);
      
      // Position in a circle
      const angle = (i / 5) * Math.PI * 2;
      cube.position.x = Math.cos(angle) * 5;
      cube.position.z = Math.sin(angle) * 5;
      cube.position.y = 0.5;
      
      cube.castShadow = true;
      cube.receiveShadow = true;
      
      scene.add(cube);
    }
  }

  function loadModel(url, onLoad, onError) {
    console.log('[initThree] loadModel called for', url);
    
    // Check if GLTFLoader is available
    if (typeof THREE.GLTFLoader === 'undefined') {
      console.warn('[initThree] GLTFLoader not available - model loading skipped');
      if (onError) onError(new Error('GLTFLoader not available'));
      return;
    }

    const loader = new THREE.GLTFLoader();
    loader.load(
      url,
      function(gltf) {
        console.log('[initThree] model loaded', url);
        if (scene) scene.add(gltf.scene);
        if (onLoad) onLoad(gltf);
      },
      function(xhr) {
        console.log('[initThree] model loading', (xhr.loaded / xhr.total * 100) + '%');
      },
      function(error) {
        console.error('[initThree] model load error', error);
        if (onError) onError(error);
      }
    );
  }

  // Player position tracking
  let playerPos = { x: 0, y: 0, z: 0 };

  function setPlayerPosition(x, y, z) {
    playerPos = { x: x || 0, y: y || 0, z: z || 0 };
    window.playerPosition = playerPos;
  }

  function getPlayerPosition() {
    return playerPos;
  }

  // Auto-initialize on DOM ready if we're on the play page
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      // Don't auto-init, let game.js call it when needed
    });
  }

})();
