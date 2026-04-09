// ============================================================
// script.js — 焚き火ASMRメインロジック
// WebGL炎シェーダー + インタラクション管理
// ============================================================

// ============================================================
// グローバル状態
// ============================================================
const state = {
  // 炎の状態
  isLit: false,              // 着火済みか
  intensity: 0.0,            // 現在の炎の強度 (0〜3.0)
  targetIntensity: 0.0,      // 目標強度（スムーズに遷移）
  logsInFire: 0,             // 炉の中の薪の数
  maxLogs: 5,                // 最大薪数
  wind: 0.0,                 // 風 (-1〜1)
  windTarget: 0.0,

  // 薪の状態（炉の外）
  availableLogs: [],         // 利用可能な薪オブジェクト

  // ドラッグ状態
  dragging: null,            // ドラッグ中の薪
  dragOffsetX: 0,
  dragOffsetY: 0,

  // アニメーション
  animFrameId: null,
  startTime: performance.now(),
};

// ============================================================
// WebGL炎レンダラー
// ============================================================
class FireRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.program = null;
    this.uniforms = {};
    this.vbo = null;
    this.initialized = false;
    // WebGL が使えない場合は Canvas 2D でフォールバック
    this.useCanvas2D = false;
    this.ctx2d = null;
    // Canvas 2D フォールバック用パーティクル
    this.flameParticles = [];
  }

  // GLSLシェーダーをインラインで定義（fire.glslの内容をJS文字列として保持）
  getVertexShader() {
    return `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;
  }

  getFragmentShader() {
    return `
      precision highp float;

      uniform float u_time;
      uniform vec2  u_resolution;
      uniform float u_intensity;
      uniform float u_wind;

      varying vec2 v_uv;

      // ---- ハッシュ関数 ----
      vec2 hash2(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
      }

      // ---- Gradient Noise ----
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
        float b = dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
        float c = dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
        float d = dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      // ---- FBM（8オクターブ）----
      float fbm(vec2 p) {
        float value = 0.0;
        float amplitude = 0.5;
        float frequency = 1.0;
        for (int i = 0; i < 8; i++) {
          value     += amplitude * noise(p * frequency);
          frequency *= 2.07;
          amplitude *= 0.5;
        }
        return value;
      }

      // ---- 複数の「炎の舌」による形状マスク ----
      float flameShape(vec2 uv, float intensity) {
        float x = uv.x - 0.5;
        float y = uv.y;
        float t = u_time;
        float flameHeight = 0.52 + intensity * 0.38;

        // 風によるオフセット（根元では弱く、先端では強い）
        float windDrift = u_wind * 0.18 * y;

        float mask = 0.0;

        // 3本の炎の舌を重ね合わせる
        // 各舌は独立した揺らぎを持ち、左右非対称になる
        for (int i = 0; i < 3; i++) {
          float fi = float(i);
          float offset = fi * 0.37;

          // 非線形スクロール：炎が上昇する視覚
          float scrollT = t * 0.55 + offset;
          float scrollY = y - scrollT * 0.35;

          // 各舌の横揺れ（時間・高さで変化。舌ごとに位相ずれ）
          float xSway = fbm(vec2(scrollY * 1.8 + offset * 3.1, t * 0.38 + offset))
                        * 0.22 - 0.11;
          // 風の影響を加算
          float tongueX = x - xSway - windDrift - (fi - 1.0) * 0.09;

          // 舌ごとの幅：根元で広く、先端で細く尖る
          float widthBase = 0.19 - fi * 0.03;
          float width = (widthBase - y * (0.13 + fi * 0.01))
                        * (0.75 + intensity * 0.25);
          width = max(width, 0.005);

          // 横方向マスク
          float tongue = 1.0 - smoothstep(0.0, width, abs(tongueX));

          // 高さ方向マスク：先端に向けて滑らかに消える
          float topFade = 1.0 - smoothstep(0.0, flameHeight - fi * 0.06, y);
          tongue *= topFade;

          // FBMで舌の輪郭を細かく乱す（乱流感）
          float edgeNoise = fbm(vec2(tongueX * 5.0 + offset, scrollY * 4.0)) * 0.18;
          tongue *= 0.82 + edgeNoise;

          mask = max(mask, tongue);
        }

        // 根元の広がり（地面に接する部分）
        float base = 1.0 - smoothstep(0.0, 0.22, y);
        mask = max(mask, base * 0.65 * (1.0 - abs(x) * 3.2));

        return clamp(mask, 0.0, 1.0);
      }

      // ---- 黒体放射に基づく精密な色温度マッピング ----
      // t=0: 暗い赤, t=0.4: 深い赤オレンジ, t=0.65: 明るいオレンジ,
      // t=0.85: 黄, t=1.0: 白〜薄黄
      vec3 temperatureToColor(float t) {
        // 暗い赤 → 赤オレンジ
        vec3 col = mix(vec3(0.31, 0.0, 0.0), vec3(0.75, 0.15, 0.01), smoothstep(0.0, 0.35, t));
        // 赤オレンジ → 明るいオレンジ
        col = mix(col, vec3(1.0, 0.45, 0.04), smoothstep(0.35, 0.6, t));
        // オレンジ → 黄
        col = mix(col, vec3(1.0, 0.75, 0.15), smoothstep(0.6, 0.82, t));
        // 黄 → 白〜薄黄（核心部）
        col = mix(col, vec3(1.0, 0.99, 0.90), smoothstep(0.82, 1.0, t));

        // ガンマ補正（炎の輝き感を強調）
        col.r = pow(max(col.r, 0.0001), 0.75);
        col.g = pow(max(col.g, 0.0001), 0.80);
        col.b = pow(max(col.b, 0.0001), 0.90);
        return col;
      }

      // ---- 煙 ----
      float smokeShape(vec2 uv) {
        float x = (uv.x - 0.5) * 2.0;
        float y = uv.y;
        if (y < 0.48) return 0.0;

        float t = u_time * 0.13;
        float sway = fbm(vec2(y * 0.9 + t, t * 0.4)) * 0.65;
        float xOff = x - sway * (y - 0.48);

        float width = 0.12 + (y - 0.48) * 0.45;
        float mask = 1.0 - smoothstep(0.0, width, abs(xOff));
        mask *= smoothstep(0.48, 0.62, y);
        mask *= 1.0 - smoothstep(0.72, 1.0, y);

        float smokeFbm = fbm(vec2(x * 3.2 + t * 0.25, y * 2.2 - t * 0.18));
        mask *= 0.45 + smokeFbm * 0.65;

        return clamp(mask * 0.32, 0.0, 1.0);
      }

      void main() {
        vec2 uv = v_uv;
        float t = u_time;
        float intensity = u_intensity;
        float flameHeight = 0.52 + intensity * 0.38;

        // ---- ドメインワーピング（IQ手法）で強力な乱流を生成 ----
        vec2 baseUV = uv * vec2(2.2, 2.8);

        // 第1層：基本FBM（非線形スクロール）
        float scrollSpeed = t * 0.72;
        vec2 q = vec2(
          fbm(baseUV + vec2(0.0, -scrollSpeed)),
          fbm(baseUV + vec2(5.2,  1.3) + vec2(0.0, -scrollSpeed * 0.9))
        );

        // 第2層：qでワープしたFBM（乱流感の核心）
        vec2 r = vec2(
          fbm(baseUV + 3.8 * q + vec2(1.7, 9.2) + vec2(0.0, -t * 0.15)),
          fbm(baseUV + 3.8 * q + vec2(8.3, 2.8) + vec2(0.0, -t * 0.126))
        );

        // 最終ノイズ値（rでさらにワープ → 強い乱流感）
        float warpedNoise = fbm(baseUV + 3.5 * r);

        // 高周波チラつき（細かい乱れ）
        float highFreqNoise = fbm(uv * vec2(6.0, 8.0) + vec2(t * 0.31, -t * 1.4)) * 0.5 + 0.5;
        // 炎全体の脈動（0.95〜1.05でゆっくり明滅）
        float pulse = 1.0 + sin(t * 1.8) * 0.03 + sin(t * 3.1 + 0.7) * 0.02;

        // UV歪み（ドメインワーピングを炎形状にも適用）
        vec2 distortedUV = uv + vec2(
          warpedNoise * 0.10 + r.x * 0.04,
          -abs(warpedNoise) * 0.03
        );

        // ---- 炎の形状（複数の舌）----
        float flame = flameShape(distortedUV, intensity);

        // ---- 温度マップ（精密化）----
        float xDist = abs((distortedUV.x - 0.5) * 2.0);
        float yNorm = clamp(uv.y / max(flameHeight, 0.01), 0.0, 1.0);

        // ベース温度：高さ・横距離で減衰
        float temp = (1.0 - pow(max(yNorm, 0.0001), 0.65)) * (1.0 - xDist * 0.5);
        // ドメインワーピングノイズで温度に揺らぎを加える
        temp += (warpedNoise * 0.5 + 0.5) * 0.18 * flame;
        temp -= highFreqNoise * 0.06 * yNorm;
        temp = clamp(temp * flame, 0.0, 1.0);

        // ---- 炎の色生成 ----
        vec3 flameColor = temperatureToColor(temp);

        // ---- 核心の白〜薄黄ハイライト ----
        // 根元中央の最高温部分が白く輝く
        float core = (1.0 - pow(max(yNorm, 0.0001), 0.5)) * (1.0 - xDist * 2.8);
        core = clamp(core, 0.0, 1.0) * flame;
        // コアにも高周波チラつきを乗せる
        float coreNoise = fbm(uv * vec2(5.0, 7.0) + vec2(r.x, -t * 1.3));
        core *= 0.55 + coreNoise * 0.55;
        // #FFFDE7 相当（白〜薄黄）
        flameColor += vec3(1.0, 0.992, 0.906) * core * 1.05;

        // ---- 外縁の暗い赤（#BF360C〜#4E0000）----
        float edge = flame * pow(max(1.0 - temp, 0.0001), 1.8);
        // #BF360C = (0.749, 0.212, 0.047)
        flameColor += vec3(0.75, 0.21, 0.05) * edge * 0.55;

        // ---- エミッション（HDRブルーム）----
        // 明るい部分が滲んで光る（根元の照り返し）
        float glowRadius = smoothstep(0.45, 0.0, abs(uv.x - 0.5))
                           * (1.0 - smoothstep(0.0, 0.3, uv.y));
        // FBMで形を崩す
        float glowFbm = fbm(uv * vec2(1.8, 2.5) + vec2(t * 0.04, -t * 0.5));
        float glow = glowRadius * (0.5 + glowFbm * 0.5) * intensity;
        // オレンジ〜赤のグロー色
        flameColor += vec3(0.9, 0.28, 0.02) * glow * 0.45;

        // 脈動を全体に適用
        flameColor *= pulse;

        // ---- 煙 ----
        float smoke = smokeShape(uv);
        vec3 smokeColor = vec3(0.33, 0.30, 0.28);

        // ---- 最終合成 ----
        float flameAlpha = clamp(length(flameColor) * 1.1, 0.0, 1.0);
        flameAlpha = max(flameAlpha, flame * 0.45);
        float smokeAlpha = smoke * (1.0 - flameAlpha * 0.85);

        vec3 finalColor = flameColor + smokeColor * smokeAlpha;
        float finalAlpha = clamp(flameAlpha + smokeAlpha, 0.0, 1.0);

        // ガンマ補正 + 輝度強化
        finalColor = pow(max(finalColor, vec3(0.0001)), vec3(0.82));
        finalColor *= 1.0 + intensity * 0.25;

        gl_FragColor = vec4(finalColor, finalAlpha);
      }
    `;
  }

  init() {
    // webgl2 → webgl の順でフォールバック取得
    const contextOptions = {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
    };
    const gl =
      this.canvas.getContext('webgl2', contextOptions) ||
      this.canvas.getContext('webgl', contextOptions) ||
      this.canvas.getContext('experimental-webgl', contextOptions);

    if (!gl) {
      console.error('WebGL not supported');
      return false;
    }

    this.gl = gl;

    // シェーダーコンパイル
    const vs = this.compileShader(gl.VERTEX_SHADER, this.getVertexShader());
    const fs = this.compileShader(gl.FRAGMENT_SHADER, this.getFragmentShader());

    if (!vs || !fs) return false;

    // プログラムリンク
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(this.program));
      return false;
    }

    // ユニフォームロケーション取得
    this.uniforms = {
      time:       gl.getUniformLocation(this.program, 'u_time'),
      resolution: gl.getUniformLocation(this.program, 'u_resolution'),
      intensity:  gl.getUniformLocation(this.program, 'u_intensity'),
      wind:       gl.getUniformLocation(this.program, 'u_wind'),
    };

    // フルスクリーン四角形の頂点バッファ
    const vertices = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // 頂点属性設定
    const posAttr = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(posAttr);
    gl.vertexAttribPointer(posAttr, 2, gl.FLOAT, false, 0, 0);

    // ブレンディング設定（炎の透明部分の合成）
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE, gl.ONE_MINUS_SRC_ALPHA
    );

    this.initialized = true;
    return true;
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  // Canvas 2D フォールバック初期化
  initCanvas2D() {
    this.useCanvas2D = true;
    this.ctx2d = this.canvas.getContext('2d');
    this.initialized = true;
    this.flameParticles = [];
  }

  // Canvas 2D フォールバック用炎パーティクルの放出
  // pitCx/pitCy/pitRadius は TakibiApp から受け取る（全画面Canvas座標系）
  emitFlameParticles(intensity, wind, pitCx, pitCy, pitRadius) {
    const count = Math.floor(intensity * 3) + 1;
    const spread = pitRadius * 0.6 * Math.min(intensity, 1.5);

    for (let i = 0; i < count; i++) {
      this.flameParticles.push({
        x: pitCx + (Math.random() - 0.5) * spread,
        y: pitCy - pitRadius * 0.1,
        vx: (Math.random() - 0.5) * 1.5 + wind * 2,
        vy: -(2.5 + Math.random() * 3.5) * (0.6 + intensity * 0.4),
        life: 1.0,
        decay: 0.012 + Math.random() * 0.018,
        size: (pitRadius * 0.25 + Math.random() * pitRadius * 0.35) * (0.7 + intensity * 0.3),
      });
    }
  }

  // Canvas 2D フォールバック描画
  renderCanvas2D(time, intensity, wind, pitCx, pitCy, pitRadius) {
    const ctx = this.ctx2d;
    const W = this.canvas.width;
    const H = this.canvas.height;

    ctx.clearRect(0, 0, W, H);

    if (intensity <= 0.01) return;

    // パーティクル放出（座標は引数から受け取る）
    this.emitFlameParticles(intensity, wind, pitCx, pitCy, pitRadius);

    // パーティクル更新・描画
    this.flameParticles = this.flameParticles.filter(p => p.life > 0);

    for (const p of this.flameParticles) {
      // 乱流でゆらぎ
      p.vx += (Math.random() - 0.5) * 0.4;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;

      if (p.life <= 0) continue;

      const alpha = Math.pow(p.life, 1.5);
      const size = p.size * p.life;

      // ライフに応じて白→黄→オレンジ→赤→暗
      const lifeRatio = p.life;
      let r, g, b;
      if (lifeRatio > 0.7) {
        // 白〜黄色
        const t = (lifeRatio - 0.7) / 0.3;
        r = 255;
        g = Math.floor(255 * (0.7 + t * 0.3));
        b = Math.floor(200 * (1 - t));
      } else if (lifeRatio > 0.4) {
        // 黄〜オレンジ
        const t = (lifeRatio - 0.4) / 0.3;
        r = 255;
        g = Math.floor(255 * t * 0.7);
        b = 0;
      } else {
        // オレンジ〜赤
        const t = lifeRatio / 0.4;
        r = Math.floor(200 + 55 * t);
        g = Math.floor(60 * t);
        b = 0;
      }

      const gradient = ctx.createRadialGradient(
        p.x, p.y, 0,
        p.x, p.y, size
      );
      gradient.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
      gradient.addColorStop(0.4, `rgba(${r},${Math.floor(g * 0.5)},0,${alpha * 0.6})`);
      gradient.addColorStop(1, `rgba(${Math.floor(r * 0.5)},0,0,0)`);

      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    // 上限を設けてメモリリーク防止
    if (this.flameParticles.length > 300) {
      this.flameParticles.splice(0, this.flameParticles.length - 300);
    }
  }

  resize(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.gl) {
      this.gl.viewport(0, 0, width, height);
    }
    // Canvas 2D フォールバックの場合はパーティクルをリセット
    if (this.useCanvas2D) {
      this.flameParticles = [];
    }
  }

  render(time, intensity, wind, pitCx, pitCy, pitRadius) {
    if (!this.initialized) return;

    // Canvas 2D フォールバックモード
    if (this.useCanvas2D) {
      this.renderCanvas2D(time, intensity, wind, pitCx, pitCy, pitRadius);
      return;
    }

    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);

    // ユニフォームを更新
    gl.uniform1f(this.uniforms.time, time);
    gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.intensity, intensity);
    gl.uniform1f(this.uniforms.wind, wind);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

// ============================================================
// 薪オブジェクト管理
// ============================================================
class Log {
  constructor(id, x, y, isSplit = false) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.width = isSplit ? 55 : 80;
    this.height = isSplit ? 22 : 30;
    this.rotation = (Math.random() - 0.5) * 0.3;
    this.isSplit = isSplit;
    this.isSplitting = false;
    this.splitProgress = 0;
    this.splitHalf = null;  // 'left' or 'right'
    this.isBeingDragged = false;
    this.inFire = false;

    // 木の色（自然なバリエーション）
    const darkness = 0.85 + Math.random() * 0.15;
    this.woodColor = `hsl(${25 + Math.random() * 15}, ${40 + Math.random() * 20}%, ${30 * darkness}%)`;
    this.barkColor = `hsl(${20 + Math.random() * 10}, ${30 + Math.random() * 15}%, ${22 * darkness}%)`;

    // 年輪のランダムバリエーション
    this.rings = Math.floor(3 + Math.random() * 4);
    this.grainAngle = Math.random() * Math.PI;
  }

  // 座標がこの薪の上にあるか判定
  hitTest(x, y) {
    const dx = x - this.x;
    const dy = y - this.y;
    const cos = Math.cos(-this.rotation);
    const sin = Math.sin(-this.rotation);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    return Math.abs(lx) < this.width / 2 && Math.abs(ly) < this.height / 2;
  }
}

// ============================================================
// Canvas 2D 薪ドローワー
// ============================================================
function drawLog(ctx, log, options = {}) {
  const { splitting = false, splitProgress = 0, half = null } = options;

  ctx.save();
  ctx.translate(log.x, log.y);
  ctx.rotate(log.rotation);

  const w = log.width;
  const h = log.height;

  if (splitting && half) {
    // 割れアニメーション：左右に分かれていく
    const spread = splitProgress * 15;
    ctx.translate(half === 'left' ? -spread : spread, 0);
    ctx.rotate(half === 'left' ? -splitProgress * 0.15 : splitProgress * 0.15);
  }

  // 影
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;

  // 薪の本体（角丸矩形）
  const rx = h * 0.45;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + rx, -h / 2);
  ctx.lineTo(w / 2 - rx, -h / 2);
  ctx.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + rx);
  ctx.lineTo(w / 2, h / 2 - rx);
  ctx.quadraticCurveTo(w / 2, h / 2, w / 2 - rx, h / 2);
  ctx.lineTo(-w / 2 + rx, h / 2);
  ctx.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - rx);
  ctx.lineTo(-w / 2, -h / 2 + rx);
  ctx.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + rx, -h / 2);
  ctx.closePath();

  // 木目グラデーション
  const gradient = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  gradient.addColorStop(0, log.barkColor);
  gradient.addColorStop(0.15, log.woodColor);
  gradient.addColorStop(0.5, adjustBrightness(log.woodColor, 1.15));
  gradient.addColorStop(0.85, log.woodColor);
  gradient.addColorStop(1, log.barkColor);
  ctx.fillStyle = gradient;
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.fill();

  // 木の皮（アウトライン）
  ctx.strokeStyle = log.barkColor;
  ctx.lineWidth = 2;
  ctx.shadowColor = 'transparent';
  ctx.stroke();

  // 断面の年輪（丸太の端面）
  if (!log.isSplit) {
    drawEndGrain(ctx, log);
  }

  // 木目のライン（側面）
  drawWoodGrain(ctx, log);

  ctx.restore();
}

function drawEndGrain(ctx, log) {
  const endX = log.width / 2 - log.height * 0.42;
  const r = log.height * 0.38;

  ctx.save();
  // 断面の背景
  ctx.beginPath();
  ctx.arc(endX, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = adjustBrightness(log.woodColor, 0.9);
  ctx.fill();
  ctx.strokeStyle = log.barkColor;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 年輪
  for (let i = log.rings; i >= 1; i--) {
    const ringR = r * (i / (log.rings + 1));
    ctx.beginPath();
    ctx.arc(endX + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0,0,0,${0.15 + (log.rings - i) * 0.05})`;
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  // 中心（髄）
  ctx.beginPath();
  ctx.arc(endX, 0, r * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill();

  ctx.restore();
}

function drawWoodGrain(ctx, log) {
  ctx.save();
  const w = log.width;
  const h = log.height;

  // クリッピング
  ctx.beginPath();
  ctx.rect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4);
  ctx.clip();

  // 縦の木目ライン
  const numGrains = Math.floor(w / 8);
  for (let i = 0; i < numGrains; i++) {
    const x = -w / 2 + (i / numGrains) * w;
    const wiggle = (Math.random() - 0.5) * 3;

    ctx.beginPath();
    ctx.moveTo(x + wiggle, -h / 2);
    ctx.bezierCurveTo(
      x + wiggle + (Math.random() - 0.5) * 4, -h / 4,
      x + wiggle + (Math.random() - 0.5) * 4, h / 4,
      x + wiggle, h / 2
    );
    ctx.strokeStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.06})`;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  ctx.restore();
}

function adjustBrightness(hslStr, factor) {
  // 簡易的な明度調整
  const match = hslStr.match(/hsl\((\d+),\s*(\d+)%,\s*([\d.]+)%\)/);
  if (!match) return hslStr;
  const l = Math.min(100, parseFloat(match[3]) * factor);
  return `hsl(${match[1]}, ${match[2]}%, ${l}%)`;
}

// ============================================================
// 炉（ファイアピット）描画
// ============================================================
function drawFirepit(ctx, cx, cy, radius, fireIntensity) {
  // 炎の光が石に反射する効果
  if (fireIntensity > 0) {
    const lightRadius = radius * (1.5 + fireIntensity * 0.8);
    const fireGlow = ctx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, lightRadius);
    fireGlow.addColorStop(0, `rgba(255, 120, 20, ${0.35 * fireIntensity})`);
    fireGlow.addColorStop(0.4, `rgba(255, 80, 10, ${0.15 * fireIntensity})`);
    fireGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fireGlow;
    ctx.fillRect(cx - lightRadius, cy - lightRadius, lightRadius * 2, lightRadius * 2);
  }

  const numStones = 12;
  const stoneData = [
    // [角度オフセット, サイズ係数, 色の暗さ]
    ...Array.from({length: numStones}, (_, i) => ({
      angle: (i / numStones) * Math.PI * 2 + 0.2 * Math.sin(i * 1.7),
      sizeFactor: 0.75 + 0.35 * Math.sin(i * 2.3 + 0.5),
      darkness: 0.5 + 0.3 * Math.cos(i * 1.5),
      xOffset: (Math.random() - 0.5) * 6,
      yOffset: (Math.random() - 0.5) * 4,
    }))
  ];

  // 石を描画
  stoneData.forEach((stone, i) => {
    const sx = cx + Math.cos(stone.angle) * radius + stone.xOffset;
    const sy = cy + Math.sin(stone.angle) * radius * 0.55 + stone.yOffset;
    const sw = (18 + stone.sizeFactor * 14);
    const sh = (10 + stone.sizeFactor * 8);

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(stone.angle + 0.3);

    // 石の影
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;

    // 石の形（不規則な楕円）
    ctx.beginPath();
    ctx.ellipse(0, 0, sw / 2, sh / 2, 0, 0, Math.PI * 2);

    // 炎の光による石の色の変化
    const fireWarmth = fireIntensity * 0.3;
    const lightR = Math.min(255, Math.floor(90 + stone.darkness * 60 + fireWarmth * 80));
    const lightG = Math.min(255, Math.floor(75 + stone.darkness * 50 + fireWarmth * 30));
    const lightB = Math.min(255, Math.floor(65 + stone.darkness * 45));

    const stoneGradient = ctx.createRadialGradient(-sw * 0.1, -sh * 0.2, 0, 0, 0, sw * 0.6);
    stoneGradient.addColorStop(0, `rgb(${lightR + 20},${lightG + 15},${lightB + 10})`);
    stoneGradient.addColorStop(0.5, `rgb(${lightR},${lightG},${lightB})`);
    stoneGradient.addColorStop(1, `rgb(${Math.max(0, lightR - 25)},${Math.max(0, lightG - 20)},${Math.max(0, lightB - 15)})`);

    ctx.fillStyle = stoneGradient;
    ctx.shadowColor = 'transparent';
    ctx.fill();

    // 石の輪郭
    ctx.strokeStyle = `rgba(0,0,0,0.3)`;
    ctx.lineWidth = 0.8;
    ctx.stroke();

    // 石のハイライト（光沢感）
    ctx.beginPath();
    ctx.ellipse(-sw * 0.1, -sh * 0.2, sw * 0.15, sh * 0.1, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();

    ctx.restore();
  });

  // 炉の内部（灰と燠）
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, radius * 0.75, radius * 0.42, 0, 0, Math.PI * 2);
  ctx.fillStyle = fireIntensity > 0
    ? `rgba(20, 12, 8, 0.85)`
    : `rgba(40, 35, 32, 0.9)`;
  ctx.fill();

  // 炭と灰
  if (fireIntensity > 0) {
    const emberCount = 8;
    for (let i = 0; i < emberCount; i++) {
      const ex = cx + (Math.random() - 0.5) * radius * 1.0;
      const ey = cy + (Math.random() - 0.5) * radius * 0.55;
      const er = 1.5 + Math.random() * 3;
      const ember = ctx.createRadialGradient(ex, ey, 0, ex, ey, er * 2);
      const brightness = 0.4 + Math.random() * 0.6;
      ember.addColorStop(0, `rgba(255, ${Math.floor(100 * brightness)}, 0, ${brightness})`);
      ember.addColorStop(1, 'rgba(255,50,0,0)');
      ctx.fillStyle = ember;
      ctx.beginPath();
      ctx.arc(ex, ey, er * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

// ============================================================
// パーティクルシステム（火の粉・煙粒子）
// ============================================================
class ParticleSystem {
  constructor() {
    this.particles = [];
  }

  emit(x, y, type, count = 1) {
    for (let i = 0; i < count; i++) {
      const particle = {
        x, y,
        type,  // 'ember' | 'smoke' | 'spark'
        vx: (Math.random() - 0.5) * (type === 'ember' ? 1.5 : 0.5),
        vy: -(0.5 + Math.random() * 2.0),
        life: 1.0,
        decay: type === 'ember' ? 0.008 + Math.random() * 0.015
             : type === 'smoke' ? 0.004 + Math.random() * 0.008
             : 0.02 + Math.random() * 0.03,
        size: type === 'ember' ? 1.5 + Math.random() * 2.5
            : type === 'smoke' ? 8 + Math.random() * 20
            : 1 + Math.random() * 1.5,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.05,
      };
      this.particles.push(particle);
    }
  }

  update() {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.98;
      p.vy -= 0.02;  // 上昇
      p.life -= p.decay;
      p.rotation += p.rotSpeed;

      // 煙は広がる
      if (p.type === 'smoke') p.size *= 1.008;

      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  draw(ctx) {
    this.particles.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.life;

      if (p.type === 'ember') {
        // 火の粉（橙〜赤のグロウ）
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3);
        const r = Math.floor(255);
        const g = Math.floor(80 + p.life * 120);
        glow.addColorStop(0, `rgb(${r}, ${g}, 0)`);
        glow.addColorStop(0.4, `rgba(255, 80, 0, 0.5)`);
        glow.addColorStop(1, 'rgba(255,0,0,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === 'smoke') {
        // 煙（灰色の半透明円）
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        const smokeGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, p.size);
        const alpha = p.life * 0.25;
        smokeGrad.addColorStop(0, `rgba(150,140,130,${alpha})`);
        smokeGrad.addColorStop(1, 'rgba(150,140,130,0)');
        ctx.fillStyle = smokeGrad;
        ctx.beginPath();
        ctx.arc(0, 0, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.type === 'spark') {
        // 火花（明るい小さな点）
        ctx.fillStyle = `rgba(255, 220, 80, ${p.life})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    });
  }
}

// ============================================================
// メインアプリ
// ============================================================
class TakibiApp {
  constructor() {
    // Canvas要素
    this.bgCanvas = document.getElementById('bg-canvas');
    this.fireCanvas = document.getElementById('fire-canvas');
    this.uiCanvas = document.getElementById('ui-canvas');

    this.bgCtx = this.bgCanvas.getContext('2d');
    this.uiCtx = this.uiCanvas.getContext('2d');

    // WebGL炎レンダラー
    this.fireRenderer = new FireRenderer(this.fireCanvas);

    // パーティクルシステム
    this.particles = new ParticleSystem();

    // 炉の中心座標（responsive）
    this.pitCx = 0;
    this.pitCy = 0;
    this.pitRadius = 0;

    // 状態
    this.audioStarted = false;
    this.currentPhase = 'initial';  // initial | igniting | burning

    this.init();
  }

  init() {
    // WebGL初期化を試みる。失敗したらCanvas 2Dフォールバックで継続
    if (!this.fireRenderer.init()) {
      // Canvas 2D フォールバックで炎描画を継続
      this.fireRenderer.initCanvas2D();
    }

    // 薪を初期配置
    this.createInitialLogs();

    // リサイズハンドラー
    window.addEventListener('resize', () => this.resize());
    this.resize();

    // イベントハンドラー設定
    this.setupEvents();

    // アニメーションループ開始
    this.animate();

    // 初期UIの設定
    this.updateUI();
  }

  resize() {
    const W = window.innerWidth;
    const H = window.innerHeight;

    [this.bgCanvas, this.fireCanvas, this.uiCanvas].forEach(c => {
      c.width = W;
      c.height = H;
    });

    this.fireRenderer.resize(W, H);

    // 炉の位置（画面下部中央）
    this.pitCx = W / 2;
    this.pitCy = H * 0.72;
    this.pitRadius = Math.min(W, H) * 0.14;

    // 炎Canvasの位置・サイズ（炉の上に重ねる）
    const fireW = this.pitRadius * 5;
    const fireH = this.pitRadius * 5;
    const fireX = this.pitCx - fireW / 2;
    const fireY = this.pitCy - fireH * 0.85;

    // Canvas 2D フォールバックの場合は全画面で描画（座標はアプリ側で管理）
    if (this.fireRenderer.useCanvas2D) {
      this.fireCanvas.style.width = `${W}px`;
      this.fireCanvas.style.height = `${H}px`;
      this.fireCanvas.style.left = '0px';
      this.fireCanvas.style.top = '0px';
    } else {
      this.fireCanvas.style.width = `${fireW}px`;
      this.fireCanvas.style.height = `${fireH}px`;
      this.fireCanvas.style.left = `${fireX}px`;
      this.fireCanvas.style.top = `${fireY}px`;
    }

    // 薪の再配置（炉の外側）
    this.repositionLogs();
  }

  createInitialLogs() {
    state.availableLogs = [];
    for (let i = 0; i < 4; i++) {
      // 初期位置は resize() 後に設定されるのでダミー座標
      const log = new Log(i, 0, 0);
      state.availableLogs.push(log);
    }
  }

  repositionLogs() {
    const W = window.innerWidth;
    const H = window.innerHeight;

    const positions = [
      { x: W * 0.12, y: H * 0.78, rot: -0.2 },
      { x: W * 0.22, y: H * 0.88, rot: 0.15 },
      { x: W * 0.78, y: H * 0.80, rot: 0.25 },
      { x: W * 0.88, y: H * 0.88, rot: -0.1 },
    ];

    state.availableLogs.forEach((log, i) => {
      if (!log.inFire && !log.isBeingDragged) {
        if (positions[i]) {
          log.x = positions[i].x;
          log.y = positions[i].y;
          log.rotation = positions[i].rot;
        }
      }
    });
  }

  // ============================================================
  // イベント処理
  // ============================================================
  setupEvents() {
    // マッチ・着火ボタン
    document.getElementById('ignite-btn').addEventListener('click', () => {
      this.ignite();
    });

    // 音量スライダー
    document.getElementById('volume-slider').addEventListener('input', (e) => {
      takibiAudio.setVolume(e.target.value / 100);
    });

    // ミュートボタン
    document.getElementById('mute-btn').addEventListener('click', () => {
      this.toggleMute();
    });

    // UICanvasでのドラッグ（薪の操作）
    this.uiCanvas.addEventListener('mousedown', (e) => this.onPointerDown(e.clientX, e.clientY));
    this.uiCanvas.addEventListener('mousemove', (e) => this.onPointerMove(e.clientX, e.clientY));
    this.uiCanvas.addEventListener('mouseup', (e) => this.onPointerUp(e.clientX, e.clientY));
    this.uiCanvas.addEventListener('click', (e) => this.onCanvasClick(e.clientX, e.clientY));

    // タッチ操作（モバイル対応）
    this.uiCanvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      this.onPointerDown(t.clientX, t.clientY);
    }, { passive: false });
    this.uiCanvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      this.onPointerMove(t.clientX, t.clientY);
    }, { passive: false });
    this.uiCanvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (e.changedTouches.length > 0) {
        const t = e.changedTouches[0];
        this.onPointerUp(t.clientX, t.clientY);
      }
    }, { passive: false });
  }

  onPointerDown(x, y) {
    // 薪のヒットテスト
    for (let i = state.availableLogs.length - 1; i >= 0; i--) {
      const log = state.availableLogs[i];
      if (!log.inFire && log.hitTest(x, y)) {
        state.dragging = log;
        log.isBeingDragged = true;
        state.dragOffsetX = log.x - x;
        state.dragOffsetY = log.y - y;
        this.uiCanvas.style.cursor = 'grabbing';

        // オーディオ初期化（ユーザージェスチャーで）
        if (!this.audioStarted) {
          this.startAudio();
        }
        break;
      }
    }
  }

  onPointerMove(x, y) {
    if (state.dragging) {
      state.dragging.x = x + state.dragOffsetX;
      state.dragging.y = y + state.dragOffsetY;
    }
  }

  onPointerUp(x, y) {
    if (state.dragging) {
      const log = state.dragging;

      // 炉の上にドロップしたか判定
      const dx = x - this.pitCx;
      const dy = y - this.pitCy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < this.pitRadius * 1.2 && state.isLit) {
        // 薪をくべる！
        this.addLogToFire(log);
      } else if (dist < this.pitRadius * 1.2 && !state.isLit) {
        // 未着火の炉に薪を置く
        this.addLogToFirepit(log);
      } else {
        // 元の位置に戻す（簡易アニメ）
        log.isBeingDragged = false;
      }

      state.dragging = null;
      this.uiCanvas.style.cursor = '';
    }
  }

  onCanvasClick(x, y) {
    // 薪をダブルクリック→割る（スプリット）
    // ここでは通常クリックで割る機能
    for (const log of state.availableLogs) {
      if (!log.inFire && !log.isSplit && log.hitTest(x, y)) {
        this.splitLog(log);

        if (!this.audioStarted) {
          this.startAudio();
        } else {
          takibiAudio.playSplitSound();
        }
        break;
      }
    }
  }

  // ============================================================
  // 薪を割る
  // ============================================================
  splitLog(log) {
    if (log.isSplitting) return;
    log.isSplitting = true;

    // 割れアニメーション
    let progress = 0;
    const animSplit = () => {
      progress += 0.04;
      log.splitProgress = Math.min(progress, 1.0);

      if (progress < 1.0) {
        requestAnimationFrame(animSplit);
      } else {
        // 割れた薪を2本に分割
        this.completeSplit(log);
      }
    };
    requestAnimationFrame(animSplit);

    // エフェクト（木片パーティクル）
    for (let i = 0; i < 6; i++) {
      this.particles.emit(log.x, log.y, 'spark', 1);
    }
  }

  completeSplit(log) {
    const idx = state.availableLogs.indexOf(log);
    if (idx === -1) return;

    // 割った薪を2本の小さい薪に置き換え
    const logLeft = new Log(Date.now(), log.x - 25, log.y - 5, true);
    logLeft.rotation = log.rotation - 0.2;
    const logRight = new Log(Date.now() + 1, log.x + 25, log.y + 5, true);
    logRight.rotation = log.rotation + 0.2;

    state.availableLogs.splice(idx, 1, logLeft, logRight);
  }

  // ============================================================
  // 着火
  // ============================================================
  ignite() {
    if (state.isLit) return;

    // 炉に薪がないと着火できない
    if (state.logsInFire === 0) {
      // 自動で薪を1本追加してから着火
      const firstLog = state.availableLogs.find(l => !l.inFire);
      if (firstLog) {
        this.addLogToFirepit(firstLog);
      }
    }

    state.isLit = true;
    state.targetIntensity = 0.4 + state.logsInFire * 0.25;
    this.currentPhase = 'igniting';

    // 着火ボタンの見た目を変える
    const btn = document.getElementById('ignite-btn');
    btn.textContent = '燃えている';
    btn.classList.add('burning');

    // 着火音
    if (!this.audioStarted) {
      this.startAudio().then(() => {
        takibiAudio.playIgniteSound();
      });
    } else {
      takibiAudio.playIgniteSound();
    }

    // 着火アニメーション（最初はゆっくり点火）
    setTimeout(() => {
      this.currentPhase = 'burning';
    }, 2000);

    this.updateUI();
  }

  // ============================================================
  // 薪を炉の内部に置く（未着火）
  // ============================================================
  addLogToFirepit(log) {
    if (state.logsInFire >= state.maxLogs) return;

    log.inFire = true;
    log.isBeingDragged = false;
    state.logsInFire++;

    // くべる音
    if (this.audioStarted) {
      takibiAudio.playAddLogSound();
    }
  }

  // ============================================================
  // 着火後に薪をくべる
  // ============================================================
  addLogToFire(log) {
    if (state.logsInFire >= state.maxLogs) {
      // 炉がいっぱい
      log.isBeingDragged = false;
      return;
    }

    log.inFire = true;
    log.isBeingDragged = false;
    state.logsInFire++;

    // 炎の強度を上げる
    state.targetIntensity = Math.min(3.0, state.targetIntensity + 0.4);

    // エフェクト
    const cx = this.pitCx;
    const cy = this.pitCy;
    for (let i = 0; i < 15; i++) {
      this.particles.emit(
        cx + (Math.random() - 0.5) * this.pitRadius,
        cy - this.pitRadius * 0.3,
        'ember',
        1
      );
    }
    for (let i = 0; i < 5; i++) {
      this.particles.emit(
        cx + (Math.random() - 0.5) * this.pitRadius * 0.5,
        cy - this.pitRadius * 0.5,
        'spark',
        1
      );
    }

    // サウンド
    if (this.audioStarted) {
      takibiAudio.playAddLogSound();
    }

    this.updateUI();
  }

  // ============================================================
  // UI更新
  // ============================================================
  updateUI() {
    const logCount = document.getElementById('log-count');
    if (logCount) {
      logCount.textContent = `薪 ${state.logsInFire}/${state.maxLogs}`;
    }
  }

  // ============================================================
  // 音声開始
  // ============================================================
  async startAudio() {
    if (this.audioStarted) return;
    this.audioStarted = true;
    await takibiAudio.start();
  }

  toggleMute() {
    const btn = document.getElementById('mute-btn');
    if (takibiAudio.volume > 0) {
      takibiAudio._prevVolume = takibiAudio.volume;
      takibiAudio.setVolume(0);
      btn.textContent = '🔇';
    } else {
      takibiAudio.setVolume(takibiAudio._prevVolume || 0.7);
      btn.textContent = '🔊';
    }
  }

  showFallback() {
    document.getElementById('webgl-fallback').style.display = 'flex';
  }

  // ============================================================
  // 背景描画（夜空・星・光の反射）
  // ============================================================
  drawBackground() {
    const ctx = this.bgCtx;
    const W = this.bgCanvas.width;
    const H = this.bgCanvas.height;

    // 夜の空（深い紺〜黒のグラデーション）
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#050510');
    sky.addColorStop(0.5, '#08080f');
    sky.addColorStop(0.75, '#0a0908');
    sky.addColorStop(1, '#050504');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // 炎の光が地面に落ちる（ambient glow）
    if (state.intensity > 0) {
      const groundY = this.pitCy + this.pitRadius * 0.5;
      const glowR = this.pitRadius * (3 + state.intensity * 2);
      const glow = ctx.createRadialGradient(
        this.pitCx, groundY, 0,
        this.pitCx, groundY, glowR
      );
      const alpha = Math.min(0.4, state.intensity * 0.18);
      glow.addColorStop(0, `rgba(255, 100, 20, ${alpha})`);
      glow.addColorStop(0.4, `rgba(200, 60, 10, ${alpha * 0.5})`);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ============================================================
  // UIキャンバスに薪・炉を描画
  // ============================================================
  drawUI() {
    const ctx = this.uiCtx;
    const W = this.uiCanvas.width;
    const H = this.uiCanvas.height;

    ctx.clearRect(0, 0, W, H);

    // 炉を描画
    drawFirepit(ctx, this.pitCx, this.pitCy, this.pitRadius, state.intensity);

    // パーティクル
    this.particles.update();
    this.particles.draw(ctx);

    // 炉の中にある薪の数に応じた灰・炭の演出
    if (state.logsInFire > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(this.pitCx, this.pitCy + 5, this.pitRadius * 0.7, this.pitRadius * 0.35, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fill();
      ctx.restore();
    }

    // 炉の外の薪を描画
    state.availableLogs.forEach(log => {
      if (!log.inFire) {
        if (log.isSplitting) {
          // 割れアニメーション中
          drawLog(ctx, log, { splitting: true, splitProgress: log.splitProgress, half: 'left' });
          drawLog(ctx, log, { splitting: true, splitProgress: log.splitProgress, half: 'right' });
        } else {
          drawLog(ctx, log);
        }
      }
    });

    // ドラッグ中の薪を最前面に
    if (state.dragging) {
      drawLog(ctx, state.dragging);

      // 炉への誘導ハイライト
      const dx = state.dragging.x - this.pitCx;
      const dy = state.dragging.y - this.pitCy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < this.pitRadius * 2) {
        ctx.save();
        ctx.strokeStyle = state.isLit
          ? `rgba(255, 160, 50, ${0.5 * (1 - dist / (this.pitRadius * 2))})`
          : `rgba(200, 200, 200, ${0.4 * (1 - dist / (this.pitRadius * 2))})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.ellipse(this.pitCx, this.pitCy, this.pitRadius * 0.85, this.pitRadius * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // ============================================================
  // アニメーションループ
  // ============================================================
  animate() {
    const now = performance.now();
    const elapsed = (now - state.startTime) / 1000;  // 秒

    // 強度のスムーズ遷移
    const intensitySpeed = 0.015;
    if (state.intensity < state.targetIntensity) {
      state.intensity = Math.min(state.targetIntensity, state.intensity + intensitySpeed);
    } else if (state.intensity > state.targetIntensity) {
      state.intensity = Math.max(state.targetIntensity, state.intensity - intensitySpeed * 0.5);
    }

    // 風のゆっくりとした変化
    state.windTarget += (Math.random() - 0.5) * 0.002;
    state.windTarget = Math.max(-0.8, Math.min(0.8, state.windTarget));
    state.wind += (state.windTarget - state.wind) * 0.01;

    // 随時パーティクル放出（燃えている間）
    if (state.isLit && state.intensity > 0.1) {
      const cx = this.pitCx;
      const cy = this.pitCy;

      if (Math.random() < state.intensity * 0.08) {
        this.particles.emit(
          cx + (Math.random() - 0.5) * this.pitRadius * 0.8,
          cy - this.pitRadius * 0.2,
          'ember', 1
        );
      }
      if (Math.random() < state.intensity * 0.03) {
        this.particles.emit(cx, cy - this.pitRadius * 0.5, 'smoke', 1);
      }
      if (Math.random() < state.intensity * 0.015) {
        this.particles.emit(
          cx + (Math.random() - 0.5) * this.pitRadius * 0.5,
          cy - this.pitRadius * 0.3,
          'spark', 2
        );
      }
    }

    // 音量を炎の強度に合わせて調整
    if (this.audioStarted && takibiAudio.isPlaying) {
      takibiAudio.setFireIntensity(state.intensity);
    }

    // 描画
    this.drawBackground();
    this.drawUI();

    // 炎レンダリング（着火後のみ）
    // Canvas 2D フォールバックの場合は pitCx/pitCy/pitRadius を渡す
    if (state.isLit && state.intensity > 0.01) {
      this.fireRenderer.render(
        elapsed, state.intensity, state.wind,
        this.pitCx, this.pitCy, this.pitRadius
      );
    } else if (this.fireRenderer.useCanvas2D) {
      // Canvas 2D フォールバックは未着火時もcanvasをクリア
      const ctx2d = this.fireRenderer.ctx2d;
      if (ctx2d) ctx2d.clearRect(0, 0, this.fireCanvas.width, this.fireCanvas.height);
    }

    state.animFrameId = requestAnimationFrame(() => this.animate());
  }
}

// ============================================================
// 初期化
// ============================================================
window.addEventListener('load', () => {
  new TakibiApp();
});
