// ============================================================
// fire.glsl — 焚き火炎シェーダー（FBMノイズベース）
// Fractal Brownian Motion で自然な揺らぎを再現
// ============================================================

// --- Vertex Shader ---
// #vertex
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}

// --- Fragment Shader ---
// #fragment
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform float u_intensity;   // 薪の本数に応じた炎の強度 (0.0〜1.0+)
uniform float u_wind;        // 風の強さ・方向 (-1.0〜1.0)

varying vec2 v_uv;

// --------------------------------------------------------
// ハッシュ関数（疑似ランダム）
// --------------------------------------------------------
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float hash(float n) {
  return fract(sin(n) * 43758.5453);
}

// --------------------------------------------------------
// Gradient Noise（スムーズなノイズ）
// --------------------------------------------------------
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f); // Smoothstep

  float a = dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
  float b = dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// --------------------------------------------------------
// FBM（Fractal Brownian Motion）- 炎の自然な揺らぎの核心
// オクターブを重ねることで複雑な有機的形状を生成
// --------------------------------------------------------
float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;

  // 6オクターブ重ねることで炎特有の細かい揺らぎを表現
  for (int i = 0; i < 6; i++) {
    value     += amplitude * noise(p * frequency);
    frequency *= 2.1;  // 2.0よりわずかにずらして自然さを増す
    amplitude *= 0.5;
  }
  return value;
}

// --------------------------------------------------------
// 炎の形状関数
// 下から上に向かって細くなる自然な炎の輪郭を定義
// --------------------------------------------------------
float flameShape(vec2 uv, float intensity) {
  // UV座標の調整（原点を炎の根本に）
  float x = (uv.x - 0.5) * 2.0;  // -1.0〜1.0
  float y = uv.y;                  // 0.0（下）〜1.0（上）

  // 炎の高さスケール（強度に応じて変わる）
  float flameHeight = 0.55 + intensity * 0.35;

  // 時間で揺れる風の影響（FBMで非線形なゆらぎ）
  float t = u_time;
  float windOffset = u_wind * 0.15 * (1.0 - y);

  // x座標に時間由来の横揺れを加える
  float sway = fbm(vec2(y * 1.5, t * 0.4)) * 0.3 * (1.0 - y * 0.5);
  float xOff = x - sway - windOffset;

  // 炎の横幅：根元が広く、上に行くほど細くなる
  float width = (1.0 - y / flameHeight) * 0.48 + 0.05;
  width *= (0.85 + intensity * 0.15);

  // 基本的な炎マスク（横幅と高さによる制限）
  float mask = 1.0 - smoothstep(0.0, width, abs(xOff));
  mask *= 1.0 - smoothstep(0.0, flameHeight, y);

  // 根本を少し太らせる（薪の上で広がる形状）
  float base = 1.0 - smoothstep(0.0, 0.25, y);
  mask = max(mask, base * 0.5 * (1.0 - abs(x) * 1.5));

  return clamp(mask, 0.0, 1.0);
}

// --------------------------------------------------------
// 温度→色変換（黒体放射の近似）
// 温度: 0.0（消えかけ）〜1.0（最高温度・白色）
// --------------------------------------------------------
vec3 temperatureToColor(float t) {
  // 焚き火の温度グラデーション
  // 0.0: 暗い赤/消えかけ
  // 0.3: 暗いオレンジ
  // 0.5: 明るいオレンジ
  // 0.7: 黄色
  // 0.9: 明るい黄色/白に近い

  vec3 col = vec3(0.0);

  // 赤成分（低温から発光）
  col.r = clamp(t * 2.5, 0.0, 1.0);

  // 緑成分（中温で発光：赤+緑=黄/オレンジ）
  col.g = clamp(t * t * 1.8 - 0.1, 0.0, 1.0);

  // 青成分（高温で発光：白色に近づく）
  col.b = clamp((t - 0.75) * 4.0, 0.0, 1.0);

  // 焚き火らしい暖色への補正
  col.r = pow(col.r, 0.8);
  col.g = pow(col.g, 1.1);

  return col;
}

// --------------------------------------------------------
// 煙の生成
// --------------------------------------------------------
float smokeShape(vec2 uv) {
  float x = (uv.x - 0.5) * 2.0;
  float y = uv.y;

  if (y < 0.5) return 0.0;

  float t = u_time * 0.15;
  float sway = fbm(vec2(y * 0.8 + t, t * 0.5)) * 0.6;
  float xOff = x - sway * (y - 0.5);

  float width = 0.15 + (y - 0.5) * 0.4;
  float mask = 1.0 - smoothstep(0.0, width, abs(xOff));
  mask *= smoothstep(0.5, 0.65, y);
  mask *= 1.0 - smoothstep(0.75, 1.0, y);

  // 煙のむくむくとした質感
  float smokeFbm = fbm(vec2(x * 3.0 + t * 0.3, y * 2.0 - t * 0.2));
  mask *= 0.5 + smokeFbm * 0.6;

  return clamp(mask * 0.35, 0.0, 1.0);
}

// --------------------------------------------------------
// メインの炎レンダリング
// --------------------------------------------------------
void main() {
  vec2 uv = v_uv;
  float t = u_time;
  float intensity = u_intensity;

  // ---- 炎のノイズ変位 ----
  // 時間で動的に変化するFBMノイズで炎の揺らぎを生成
  vec2 noiseUV = uv * vec2(2.5, 3.0) + vec2(0.0, -t * 0.9);

  // 低周波ノイズ（大きな揺らぎ）
  float n1 = fbm(noiseUV + vec2(t * 0.12, 0.0));
  // 高周波ノイズ（細かい揺らぎ）
  float n2 = fbm(noiseUV * 1.8 + vec2(-t * 0.18, t * 0.05));
  // さらに細かいディテール
  float n3 = fbm(noiseUV * 3.5 + vec2(t * 0.08, -t * 0.1));

  // ノイズを組み合わせて最終的な変位量を計算
  float combinedNoise = n1 * 0.55 + n2 * 0.3 + n3 * 0.15;

  // ---- 炎の形状計算 ----
  // ノイズで変位したUV座標で炎の形を判定
  vec2 distortedUV = uv + vec2(combinedNoise * 0.12, 0.0);
  float flame = flameShape(distortedUV, intensity);

  // ---- 温度マップ ----
  // 炎の内部での温度分布（中心が高温・外縁が低温）
  float xDist = abs((distortedUV.x - 0.5) * 2.0);
  float yNorm = uv.y / (0.55 + intensity * 0.35);

  // 温度：中心・下部が高く、外縁・上部が低い
  float temp = flame * (1.0 - yNorm * 0.7) * (1.0 - xDist * 0.4);
  temp += combinedNoise * 0.15 * flame;  // ノイズで温度にムラを加える
  temp = clamp(temp, 0.0, 1.0);

  // ---- 炎の色生成 ----
  vec3 flameColor = temperatureToColor(temp);

  // ---- 内炎（白〜黄色の核）----
  float core = (1.0 - yNorm * 1.2) * (1.0 - xDist * 2.0);
  core = clamp(core, 0.0, 1.0);
  core *= flame;
  // 内炎ノイズ
  float coreNoise = fbm(uv * vec2(4.0, 6.0) + vec2(0.0, -t * 1.2));
  core *= 0.6 + coreNoise * 0.5;
  flameColor += vec3(1.0, 0.97, 0.85) * core * 0.9;  // 白っぽい核

  // ---- 外炎の赤みと透明感 ----
  float edge = flame * (1.0 - temp * 0.7);
  flameColor += vec3(0.6, 0.05, 0.0) * edge * 0.4;

  // ---- HDRブルーム効果（炎の輝き感） ----
  float bloomFbm = fbm(uv * vec2(2.0, 3.0) + vec2(t * 0.05, -t * 0.6));
  float bloom = smoothstep(0.3, 0.0, abs((uv.x - 0.5) * 2.0)) * bloomFbm;
  bloom *= (1.0 - uv.y * 1.2);
  bloom = clamp(bloom * intensity, 0.0, 0.5);
  flameColor += vec3(0.8, 0.3, 0.0) * bloom * 0.3;

  // ---- 煙 ----
  float smoke = smokeShape(uv);
  vec3 smokeColor = vec3(0.35, 0.32, 0.3);

  // ---- 最終合成 ----
  // 炎のアルファ（輝度ベース）
  float flameAlpha = clamp(length(flameColor) * 1.2, 0.0, 1.0);
  flameAlpha = max(flameAlpha, flame * 0.4);

  // 煙のアルファ（炎が薄い部分に重ねる）
  float smokeAlpha = smoke * (1.0 - flameAlpha * 0.8);

  // 最終カラー合成
  vec3 finalColor = flameColor + smokeColor * smokeAlpha;
  float finalAlpha = clamp(flameAlpha + smokeAlpha, 0.0, 1.0);

  // 輝度の強化（HDR風）
  finalColor = pow(finalColor, vec3(0.85));  // ガンマ補正
  finalColor *= 1.0 + intensity * 0.2;       // 強度による明るさ補正

  gl_FragColor = vec4(finalColor, finalAlpha);
}
