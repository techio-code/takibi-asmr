// ============================================================
// audio.js — 焚き火ASMRサウンドエンジン（Web Audio API）
// ============================================================

class TakibiAudio {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.crackleInterval = null;
    this.deepRumbleNode = null;
    this.isPlaying = false;
    this.volume = 0.7;
  }

  // オーディオコンテキストを初期化（ユーザージェスチャー後に呼ぶ）
  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    // マスターゲイン（全体音量）
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);
  }

  // ============================================================
  // 焚き火の環境音（ローパスフィルタされたホワイトノイズ）
  // パチパチ感を出すためにランダムに変調
  // ============================================================
  startAmbience() {
    if (!this.ctx) return;

    const bufferSize = this.ctx.sampleRate * 3;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // ピンクノイズ生成（ホワイトノイズより自然な周波数特性）
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }

    // ループ再生ノード
    this.ambienceSource = this.ctx.createBufferSource();
    this.ambienceSource.buffer = buffer;
    this.ambienceSource.loop = true;

    // ローパスフィルタ（炎の低いゴーッとした音を表現）
    this.ambienceLPF = this.ctx.createBiquadFilter();
    this.ambienceLPF.type = 'lowpass';
    this.ambienceLPF.frequency.setValueAtTime(900, this.ctx.currentTime);
    this.ambienceLPF.Q.setValueAtTime(0.5, this.ctx.currentTime);

    // ハイパスフィルタ（低すぎる成分を除去）
    this.ambienceHPF = this.ctx.createBiquadFilter();
    this.ambienceHPF.type = 'highpass';
    this.ambienceHPF.frequency.setValueAtTime(80, this.ctx.currentTime);

    // アンビエンス専用ゲイン
    this.ambienceGain = this.ctx.createGain();
    this.ambienceGain.gain.setValueAtTime(0.55, this.ctx.currentTime);

    // 接続
    this.ambienceSource
      .connect(this.ambienceLPF)
      .connect(this.ambienceHPF)
      .connect(this.ambienceGain)
      .connect(this.masterGain);

    this.ambienceSource.start();
  }

  // ============================================================
  // パチパチクラックル音（不規則な薪のはじける音）
  // ============================================================
  scheduleCrackle() {
    if (!this.ctx || !this.isPlaying) return;

    // 次のパチパチまでのランダムな間隔（0.3〜2.5秒）
    const delay = 0.3 + Math.random() * 2.2;

    setTimeout(() => {
      if (!this.isPlaying) return;
      this.playCrackle();
      this.scheduleCrackle();  // 再帰的に次をスケジュール
    }, delay * 1000);
  }

  playCrackle() {
    if (!this.ctx) return;

    const now = this.ctx.currentTime;

    // バーストノイズ（短い爆発音）
    const bufferSize = Math.floor(this.ctx.sampleRate * (0.05 + Math.random() * 0.15));
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // クリック感のある鋭いノイズ
    for (let i = 0; i < bufferSize; i++) {
      const envelope = Math.exp(-i / (bufferSize * 0.15));  // 急速な減衰
      data[i] = (Math.random() * 2 - 1) * envelope;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    // バンドパスフィルタ（パチパチらしい周波数帯域）
    const bpf = this.ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(1200 + Math.random() * 2000, now);
    bpf.Q.setValueAtTime(0.8, now);

    // ゲイン（音量のランダムバリエーション）
    const gainNode = this.ctx.createGain();
    const crackleVol = 0.15 + Math.random() * 0.35;
    gainNode.gain.setValueAtTime(crackleVol, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    source.connect(bpf).connect(gainNode).connect(this.masterGain);
    source.start(now);
    source.stop(now + 0.2);
  }

  // ============================================================
  // 大きな爆ぜ音（薪がバキッとはじける）
  // ============================================================
  schedulePop() {
    if (!this.ctx || !this.isPlaying) return;

    // 5〜20秒ごとにランダムに大きな爆ぜ音
    const delay = 5 + Math.random() * 15;

    setTimeout(() => {
      if (!this.isPlaying) return;
      this.playPop();
      this.schedulePop();
    }, delay * 1000);
  }

  playPop() {
    if (!this.ctx) return;

    const now = this.ctx.currentTime;

    // 低音の爆発的なバースト
    const bufferSize = Math.floor(this.ctx.sampleRate * 0.4);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      // 最初にパン！とした鋭い音、その後に残響
      const snap = i < bufferSize * 0.05
        ? (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.02))
        : 0;
      const rumble = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.3)) * 0.3;
      data[i] = snap + rumble;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    // 低域強調フィルタ
    const lpf = this.ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.setValueAtTime(3000, now);

    // コンプレッサー（パン！という感触を強調）
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-20, now);
    compressor.ratio.setValueAtTime(8, now);
    compressor.attack.setValueAtTime(0.001, now);
    compressor.release.setValueAtTime(0.1, now);

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(0.5 + Math.random() * 0.3, now);

    source.connect(lpf).connect(compressor).connect(gainNode).connect(this.masterGain);
    source.start(now);
    source.stop(now + 0.5);
  }

  // ============================================================
  // 薪を割る音（ガツッ→バキッという2段階の音）
  // ============================================================
  playSplitSound() {
    if (!this.ctx) return;

    const now = this.ctx.currentTime;

    // 第1打撃（斧が当たるガツッ）
    this.playImpact(now, 0.0, 280, 0.7);

    // 第2打撃（薪が割れるバキッ）- 80ms後
    this.playImpact(now + 0.08, 900, 1800, 0.5);

    // 木が割れる高音クラック - 120ms後
    this.playCrackSound(now + 0.12);
  }

  playImpact(time, freq, maxFreq, volume) {
    if (!this.ctx) return;

    const bufferSize = Math.floor(this.ctx.sampleRate * 0.3);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.08));
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const bpf = this.ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(freq + Math.random() * (maxFreq - freq), time);
    bpf.Q.setValueAtTime(1.2, time);

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(volume, time);

    source.connect(bpf).connect(gainNode).connect(this.masterGain);
    source.start(time);
    source.stop(time + 0.4);
  }

  playCrackSound(time) {
    if (!this.ctx) return;

    const bufferSize = Math.floor(this.ctx.sampleRate * 0.15);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.12));
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const hpf = this.ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.setValueAtTime(2000, time);

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(0.4, time);

    source.connect(hpf).connect(gainNode).connect(this.masterGain);
    source.start(time);
    source.stop(time + 0.2);
  }

  // ============================================================
  // 着火音（マッチ/ライターのシュッ→チリチリ）
  // ============================================================
  playIgniteSound() {
    if (!this.ctx) return;

    const now = this.ctx.currentTime;

    // シュッという摩擦音
    const bufferSize = Math.floor(this.ctx.sampleRate * 0.15);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      // 最初は低い摩擦音、後半で高音の点火音
      const env = i / bufferSize;
      const noise = Math.random() * 2 - 1;
      data[i] = noise * (0.3 + env * 0.7) * (1.0 - env * 0.3);
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const hpf = this.ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.setValueAtTime(3000, now);
    hpf.frequency.exponentialRampToValueAtTime(8000, now + 0.1);

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(0.0, now);
    gainNode.gain.linearRampToValueAtTime(0.6, now + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    source.connect(hpf).connect(gainNode).connect(this.masterGain);
    source.start(now);
    source.stop(now + 0.25);

    // チリチリと燃え始める音（0.15秒後）
    setTimeout(() => {
      this.playCrackle();
      setTimeout(() => this.playCrackle(), 200);
      setTimeout(() => this.playCrackle(), 450);
    }, 150);
  }

  // ============================================================
  // 薪をくべる音（ドスッ→じゅわぁーっ）
  // ============================================================
  playAddLogSound() {
    if (!this.ctx) return;

    const now = this.ctx.currentTime;

    // ドスッという重い音
    this.playImpact(now, 60, 200, 0.6);

    // じゅわぁーっ（蒸気音）- 100ms後
    const steamDuration = 0.8;
    const steamBuf = Math.floor(this.ctx.sampleRate * steamDuration);
    const steamBuffer = this.ctx.createBuffer(1, steamBuf, this.ctx.sampleRate);
    const steamData = steamBuffer.getChannelData(0);

    for (let i = 0; i < steamBuf; i++) {
      const env = Math.exp(-i / (steamBuf * 0.35));
      steamData[i] = (Math.random() * 2 - 1) * env;
    }

    const steamSource = this.ctx.createBufferSource();
    steamSource.buffer = steamBuffer;

    const steamBPF = this.ctx.createBiquadFilter();
    steamBPF.type = 'bandpass';
    steamBPF.frequency.setValueAtTime(2500, now + 0.1);
    steamBPF.Q.setValueAtTime(0.5, now + 0.1);

    const steamGain = this.ctx.createGain();
    steamGain.gain.setValueAtTime(0.35, now + 0.1);

    steamSource.connect(steamBPF).connect(steamGain).connect(this.masterGain);
    steamSource.start(now + 0.1);
    steamSource.stop(now + 0.1 + steamDuration);

    // パチパチを追加
    setTimeout(() => this.playCrackle(), 300);
    setTimeout(() => this.playCrackle(), 600);
  }

  // ============================================================
  // 再生開始（フェードイン）
  // ============================================================
  async start() {
    await this.init();
    this.isPlaying = true;

    this.startAmbience();
    this.scheduleCrackle();
    this.schedulePop();

    // フェードイン（3秒かけてゆっくり）
    this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
    this.masterGain.gain.linearRampToValueAtTime(
      this.volume,
      this.ctx.currentTime + 3.0
    );
  }

  // ============================================================
  // 停止（フェードアウト）
  // ============================================================
  stop() {
    if (!this.ctx) return;
    this.isPlaying = false;

    this.masterGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1.0);

    setTimeout(() => {
      if (this.ambienceSource) {
        try { this.ambienceSource.stop(); } catch (e) {}
      }
    }, 1200);
  }

  // ============================================================
  // 音量設定
  // ============================================================
  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && this.isPlaying) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.1);
    }
  }

  // ============================================================
  // 炎の強度に応じてアンビエンス音を調整
  // ============================================================
  setFireIntensity(intensity) {
    if (!this.ambienceLPF || !this.ambienceGain) return;

    const now = this.ctx.currentTime;
    // 炎が大きいほど低い周波数成分が増える
    this.ambienceLPF.frequency.setTargetAtTime(
      600 + intensity * 600,
      now, 0.5
    );
    // 音量も炎の強さに比例
    this.ambienceGain.gain.setTargetAtTime(
      0.3 + intensity * 0.4,
      now, 0.8
    );
  }
}

// シングルトンインスタンスとしてエクスポート
const takibiAudio = new TakibiAudio();
