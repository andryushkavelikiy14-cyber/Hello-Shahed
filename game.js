// --- СЕТЕВОЙ МОДУЛЬ ---
class Network {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.otherPlayers = {};
    }

    connect(onShootCallback) {
        const host = window.location.hostname || 'localhost';
        this.ws = new WebSocket(`ws://${host}:8001`);

        this.ws.onopen = () => { console.log("Сеть: Подключено"); this.connected = true; };
        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === "state") this.updateOtherPlayers(data.players);
            if (data.type === "shoot" && onShootCallback) onShootCallback();
        };
        this.ws.onclose = () => { this.connected = false; };
    }

    sendMove(x, y, z, rx, ry, rz, mode) {
        if (this.connected) this.ws.send(JSON.stringify({ type: "move", x, y, z, rx, ry, rz, mode }));
    }

    sendShoot() {
        if (this.connected) this.ws.send(JSON.stringify({ type: "shoot" }));
    }

    updateOtherPlayers(serverPlayers) {
        if (!Game.scene) return;
        for (let id in serverPlayers) {
            if (!this.otherPlayers[id]) {
                // Создаем модель для другого игрока
                const geo = new THREE.CapsuleGeometry(1, 2, 8, 16);
                const mat = new THREE.MeshStandardMaterial({ color: 0xff0000 }); // Красный для других
                const mesh = new THREE.Mesh(geo, mat);
                Game.scene.add(mesh);
                this.otherPlayers[id] = mesh;
            }
            const p = serverPlayers[id];
            this.otherPlayers[id].position.set(p.x, p.y, p.z);
            // Простой поворот
            this.otherPlayers[id].rotation.y = p.ry;
        }

        // Удаление вышедших
        for (let id in this.otherPlayers) {
            if (!serverPlayers[id]) {
                Game.scene.remove(this.otherPlayers[id]);
                delete this.otherPlayers[id];
            }
        }
    }
}

const Game = {
    isRunning: false,
    isDead: false,
    isDroneMode: false,
    isMultiplayer: false,
    scene: null, camera: null, renderer: null, clock: new THREE.Clock(),
    drones: [], playerPos: new THREE.Vector3(0, 2, 0),
    keys: { w: false, a: false, s: false, d: false },
    mouse: { x: 0, y: 0 },
    joystickLeft: { x: 0, y: 0 },
    isTargeting: false, targetDrone: null,
    textures: {},
    net: new Network(),

    init: function() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB);
        this.scene.fog = new THREE.Fog(0x87CEEB, 50, 300);

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(0, 3, 0);
        this.camera.rotation.order = 'YXZ'; // Важно для правильного вращения

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        document.body.appendChild(this.renderer.domElement);

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(10, 20, 10);
        dirLight.castShadow = true;
        this.scene.add(dirLight);

        this.loadTextures();
        this.setupAudio();
        this.setupEvents();
        this.animate();
    },

    loadTextures: function() {
        const loader = new THREE.TextureLoader();
        this.textures.ground = loader.load('https://threejs.org/examples/textures/terrain/grasslight-big.jpg');
        this.textures.building = loader.load('https://threejs.org/examples/textures/brick_diffuse.jpg');
        this.textures.bunker = loader.load('https://threejs.org/examples/textures/metal.jpg');
        
        this.textures.ground.wrapS = this.textures.ground.wrapT = THREE.RepeatWrapping;
        this.textures.ground.repeat.set(50, 50);
        this.textures.building.wrapS = this.textures.building.wrapT = THREE.RepeatWrapping;
        this.textures.building.repeat.set(2, 4);
    },

    generateCity: function() {
        const groundGeo = new THREE.PlaneGeometry(1000, 1000);
        const groundMat = new THREE.MeshStandardMaterial({ map: this.textures.ground });
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.scene.add(ground);

        const bunkerGroup = new THREE.Group();
        const bunkerMat = new THREE.MeshStandardMaterial({ map: this.textures.bunker, metalness: 0.8, roughness: 0.2 });
        
        const wallGeo = new THREE.CylinderGeometry(10, 10, 6, 16, 1, true);
        const wall = new THREE.Mesh(wallGeo, bunkerMat);
        wall.position.y = 3;
        bunkerGroup.add(wall);

        const roofGeo = new THREE.CylinderGeometry(10, 10, 0.5, 16);
        const roof = new THREE.Mesh(roofGeo, bunkerMat);
        roof.position.y = 6;
        bunkerGroup.add(roof);

        this.scene.add(bunkerGroup);

        for (let i = 0; i < 40; i++) {
            const w = 10 + Math.random() * 20;
            const h = 20 + Math.random() * 40;
            const d = 10 + Math.random() * 20;
            const geo = new THREE.BoxGeometry(w, h, d);
            const mat = new THREE.MeshStandardMaterial({ map: this.textures.building });
            const building = new THREE.Mesh(geo, mat);
            
            let x = (Math.random() - 0.5) * 300;
            let z = (Math.random() - 0.5) * 300;
            if (Math.sqrt(x*x + z*z) < 30) { x += 50; z += 50; } 
            
            building.position.set(x, h / 2, z);
            building.castShadow = true;
            building.receiveShadow = true;
            this.scene.add(building);
        }
    },

    spawnPlayer: function() {
        this.playerPos.set(0, 2, 0);
        this.camera.position.copy(this.playerPos);
        
        // РПГ
        const rpgGeo = new THREE.CylinderGeometry(0.1, 0.1, 2, 8);
        const rpgMat = new THREE.MeshStandardMaterial({ color: 0x556b2f });
        const rpg = new THREE.Mesh(rpgGeo, rpgMat);
        rpg.position.set(0.5, -0.5, -1.5);
        rpg.rotation.x = Math.PI / 2;
        this.camera.add(rpg);
        this.scene.add(this.camera);
    },

    startAsDrone: function() {
        this.isDroneMode = true;
        this.isRunning = true;
        document.getElementById('drone-select-menu').style.display = 'none';
        document.getElementById('drone-hud').style.display = 'block';
        document.getElementById('weapon-info').style.display = 'none';
        document.getElementById('game-ui').style.display = 'block';
        document.getElementById('main-menu').style.display = 'none';
        document.getElementById('click-to-play').style.display = 'none';

        if (!this.scene) this.init();
        this.generateCity();
        
        this.playerPos.set(0, 40, 100);
        this.camera.position.copy(this.playerPos);
    },

    spawnBotDrone: function() {
        const group = new THREE.Group();
        const geo = new THREE.ConeGeometry(1.5, 5, 8);
        geo.rotateX(Math.PI / 2);
        const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x666666 }));
        const wings = new THREE.Mesh(new THREE.BoxGeometry(10, 0.2, 2), new THREE.MeshStandardMaterial({ color: 0x333333 }));
        group.add(body); group.add(wings);
        group.position.set((Math.random() - 0.5) * 100, 30, (Math.random() - 0.5) * 100 - 50);
        this.scene.add(group);
        this.drones.push(group);
        this.playDroneSound();
    },

    setupAudio: function() {
        try { this.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
    },
    playDroneSound: function() {
        if (!this.audioCtx) return;
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(100, this.audioCtx.currentTime);
        gain.gain.setValueAtTime(0.05, this.audioCtx.currentTime);
        osc.connect(gain); gain.connect(this.audioCtx.destination);
        osc.start(); osc.stop(this.audioCtx.currentTime + 2);
    },
    playExplosionSound: function() {
        if (!this.audioCtx) return;
        const bufferSize = this.audioCtx.sampleRate * 1;
        const buffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
        const noise = this.audioCtx.createBufferSource();
        noise.buffer = buffer;
        const gain = this.audioCtx.createGain();
        gain.gain.setValueAtTime(1, this.audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 1);
        noise.connect(gain); gain.connect(this.audioCtx.destination);
        noise.start();
    },

    createExplosion: function(pos) {
        this.playExplosionSound();
        const pGeo = new THREE.BufferGeometry();
        const pPos = new Float32Array(30 * 3);
        for(let i=0; i<30; i++) { pPos[i*3]=pos.x; pPos[i*3+1]=pos.y; pPos[i*3+2]=pos.z; }
        pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
        const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0xff4400, size: 2 }));
        this.scene.add(particles);
        setTimeout(() => this.scene.remove(particles), 500);
    },

    shoot: function() {
        if (this.isDroneMode) return; // Дрон не стреляет
        if (this.isTargeting && this.targetDrone) {
            this.createExplosion(this.targetDrone.position);
            this.scene.remove(this.targetDrone);
            this.drones = this.drones.filter(d => d !== this.targetDrone);
            this.targetDrone = null;
            this.isTargeting = false;
            document.getElementById('crosshair').classList.remove('targeting');
            if (this.isMultiplayer) this.net.sendShoot();
        }
    },

    die: function() {
        this.isDead = true;
        document.getElementById('game-ui').style.display = 'none';
        document.getElementById('death-screen').style.display = 'flex';
        document.exitPointerLock();
    },

    animate: function() {
        requestAnimationFrame(() => this.animate());
        const delta = this.clock.getDelta();

        if (this.isRunning && !this.isDead) {
            // Исправленное управление
            const speed = this.isDroneMode ? 30 * delta : 15 * delta;
            const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
            if (!this.isDroneMode) forward.y = 0; 
            forward.normalize();
            
            // Вектор "вправо" теперь правильный
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
            right.y = 0; right.normalize();

            // ВНИМАНИЕ: Исправлена логика (A = минус, D = плюс)
            if (this.keys.w || this.joystickLeft.y > 0.2) this.playerPos.add(forward.clone().multiplyScalar(speed));
            if (this.keys.s || this.joystickLeft.y < -0.2) this.playerPos.sub(forward.clone().multiplyScalar(speed));
            if (this.keys.a || this.joystickLeft.x < -0.2) this.playerPos.sub(right.clone().multiplyScalar(speed));
            if (this.keys.d || this.joystickLeft.x > 0.2) this.playerPos.add(right.clone().multiplyScalar(speed));

            this.camera.position.copy(this.playerPos);
            if (!this.isDroneMode) this.camera.position.y = 3;

            // Вращение мышью через Pointer Lock
            this.camera.rotation.y -= this.mouse.x * 0.002;
            this.camera.rotation.x -= this.mouse.y * 0.002;
            this.camera.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, this.camera.rotation.x));
            
            this.mouse.x = 0; this.mouse.y = 0; // Сброс после применения

            // Мультиплеер: отправка позиции
            if (this.isMultiplayer) {
                this.net.sendMove(this.playerPos.x, this.playerPos.y, this.playerPos.z, this.camera.rotation.x, this.camera.rotation.y, this.camera.rotation.z, this.isDroneMode ? 'drone' : 'human');
            }

            // Дроны (Боты)
            for (let i = this.drones.length - 1; i >= 0; i--) {
                const drone = this.drones[i];
                const dir = new THREE.Vector3().subVectors(this.camera.position, drone.position).normalize();
                drone.position.add(dir.multiplyScalar(0.15)); 
                drone.lookAt(this.camera.position);

                if (drone.position.distanceTo(this.camera.position) < 5) {
                    this.createExplosion(drone.position);
                    this.scene.remove(drone);
                    this.drones.splice(i, 1);
                    if (!this.isDead) this.die();
                }
            }

            if (!this.isDroneMode) this.checkTargeting();
        }

        this.renderer.render(this.scene, this.camera);
    },

    checkTargeting: function() {
        if (this.drones.length === 0) {
            document.getElementById('crosshair').classList.remove('targeting');
            return;
        }
        let closest = null; let minDist = 80;

        this.drones.forEach(drone => {
            const vector = drone.position.clone().project(this.camera);
            const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
            const y = (-vector.y * 0.5 + 0.5) * window.innerHeight;
            const dist = Math.sqrt(Math.pow(x - window.innerWidth/2, 2) + Math.pow(y - window.innerHeight/2, 2));
            if (dist < minDist) { minDist = dist; closest = drone; }
        });

        const ch = document.getElementById('crosshair');
        if (closest) {
            this.isTargeting = true;
            this.targetDrone = closest;
            ch.classList.add('targeting');
        } else {
            this.isTargeting = false;
            this.targetDrone = null;
            ch.classList.remove('targeting');
        }
    },

    setupEvents: function() {
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });

        document.addEventListener('keydown', (e) => { if (e.key.toLowerCase() in this.keys) this.keys[e.key.toLowerCase()] = true; });
        document.addEventListener('keyup', (e) => { if (e.key.toLowerCase() in this.keys) this.keys[e.key.toLowerCase()] = false; });

        // Pointer Lock API (Фиксация мыши)
        document.getElementById('click-to-play').addEventListener('click', () => {
            document.getElementById('click-to-play').style.display = 'none';
            document.body.requestPointerLock();
        });

        document.addEventListener('pointerlockchange', () => {
            if (document.pointerLockElement === document.body) {
                // Мышь захвачена
            } else {
                // Мышь отпущена (Esc)
                if (this.isRunning) document.getElementById('click-to-play').style.display = 'flex';
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (document.pointerLockElement === document.body) {
                this.mouse.x = e.movementX || e.mozMovementX || e.webkitMovementX || 0;
                this.mouse.y = e.movementY || e.mozMovementY || e.webkitMovementY || 0;
            }
        });

        document.addEventListener('mousedown', (e) => { 
            if (this.isRunning && document.pointerLockElement === document.body && e.button === 0) this.shoot(); 
        });

        // Мобильное управление (заглушка)
        if ('ontouchstart' in window) {
            document.getElementById('joystick-zone-left').style.display = 'block';
            const leftZone = document.getElementById('joystick-zone-left');
            const leftKnob = leftZone.querySelector('.joystick-knob');
            
            leftZone.addEventListener('touchmove', (e) => {
                e.preventDefault();
                const touch = e.touches[0];
                const rect = leftZone.getBoundingClientRect();
                const x = touch.clientX - rect.left - 60;
                const y = touch.clientY - rect.top - 60;
                leftKnob.style.transform = `translate(${x}px, ${y}px)`;
                this.joystickLeft.x = x / 60;
                this.joystickLeft.y = -y / 60;
            });
            leftZone.addEventListener('touchend', () => {
                leftKnob.style.transform = 'translate(-50%, -50%)';
                this.joystickLeft.x = 0; this.joystickLeft.y = 0;
            });
        }
    },

    showDroneMenu: function() {
        document.getElementById('drone-select-menu').style.display = 'block';
    },

    start: function(mode) {
        this.isMultiplayer = (mode === 'multi');
        document.getElementById('main-menu').style.display = 'none';
        document.getElementById('game-ui').style.display = 'block';
        document.getElementById('click-to-play').style.display = 'flex';
        
        if (!this.scene) this.init();
        this.generateCity();
        this.spawnPlayer();
        
        this.isRunning = true;
        this.isDead = false;
        this.isDroneMode = false;
        this.playerPos.set(0, 2, 0);
        this.camera.position.copy(this.playerPos);
        this.camera.rotation.set(0, 0, 0);

        if (this.isMultiplayer) {
            this.net.connect(() => this.playExplosionSound());
        } else {
            setTimeout(() => { if(this.isRunning && !this.isDroneMode) this.spawnBotDrone(); }, 5000);
            setTimeout(() => { if(this.isRunning && !this.isDroneMode) this.spawnBotDrone(); }, 15000);
        }
    },

    respawn: function() {
        document.getElementById('death-screen').style.display = 'none';
        document.getElementById('main-menu').style.display = 'flex';
        this.isRunning = false;
        this.isDead = false;
        this.isDroneMode = false;
        this.drones.forEach(d => this.scene.remove(d));
        this.drones = [];
        if (this.scene) {
            while(this.scene.children.length > 0){ this.scene.remove(this.scene.children[0]); }
            this.scene = null;
        }
    }
};

window.onload = () => {
    console.log("Игра готова. Нажмите кнопку в меню.");
};