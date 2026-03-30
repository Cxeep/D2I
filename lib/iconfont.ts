/**
 * UI 侧（浏览器环境）几何特征工具：
 * - 输入：SVG pathData（即 `<path d="...">` 的 d 字符串）
 * - 输出：用于粗匹配的向量表示
 *
 * 说明：该文件不要引用 `mg/figma` 等主线程 API。
 */

export function radialSignatureFromPathData(pathData: string, bins = 64, samples = 256): number[] {
    const svgNS = "http://www.w3.org/2000/svg";
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", pathData);
    const len = path.getTotalLength();
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < samples; i++) {
        const p = path.getPointAtLength((i / (samples - 1)) * len);
        pts.push({ x: p.x, y: p.y });
    }
    // 质心
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    // 径向桶：每桶最大半径
    const sig = Array.from({ length: bins }, () => 0);
    for (const p of pts) {
        const dx = p.x - cx, dy = p.y - cy;
        const theta = Math.atan2(dy, dx); // [-pi, pi]
        const t01 = (theta + Math.PI) / (2 * Math.PI); // [0,1)
        const b = Math.min(bins - 1, Math.floor(t01 * bins));
        const r = Math.hypot(dx, dy);
        if (r > sig[b]) sig[b] = r;
    }
    // 归一化（去尺度）
    const maxR = Math.max(...sig) || 1;
    return sig.map(v => v / maxR);
}

/**
 * 将一维签名转换为“傅里叶幅值描述子”（rotation/cyclic-shift invariant）。
 *
 * 直觉：旋转会导致径向签名在角度桶维度发生循环位移；频域幅值对循环位移不敏感（相位会变化，幅值不变）。
 *
 * 注意：
 * - 这里用的是 DFT（O(N^2)），N=64/128 时足够快；如果后续 N 很大再换 FFT。
 * - 输出默认丢弃 DC(0) 分量并做归一化，避免尺度/整体偏置影响。
 */
export function fourierMagnitudeDescriptor(
    sig: number[],
    opts?: {
        /** 保留前 k 个频率幅值（不含 DC）。默认 min(16, floor(N/2)-1)。 */
        keep?: number;
        /** 是否对输入去均值（移除 DC）。默认 true。 */
        demean?: boolean;
        /** 是否对输出做 L2 归一化。默认 true。 */
        l2Normalize?: boolean;
    }
): number[] {
    const N = sig.length;
    if (N === 0) return [];

    const demean = opts?.demean ?? true;
    const l2Normalize = opts?.l2Normalize ?? true;
    const maxKeep = Math.max(0, Math.floor(N / 2) - 1);
    const keep = Math.min(opts?.keep ?? Math.min(16, maxKeep), maxKeep);

    // 去均值（可选）
    let x = sig;
    if (demean) {
        const mean = sig.reduce((a, b) => a + b, 0) / N;
        x = sig.map(v => v - mean);
    }

    // 计算 1..keep 的幅值（跳过 k=0 的 DC 分量）
    const mags: number[] = [];
    for (let k = 1; k <= keep; k++) {
        let re = 0;
        let im = 0;
        for (let n = 0; n < N; n++) {
            const angle = (-2 * Math.PI * k * n) / N;
            const c = Math.cos(angle);
            const s = Math.sin(angle);
            re += x[n] * c;
            im += x[n] * s;
        }
        mags.push(Math.hypot(re, im));
    }

    if (!l2Normalize) return mags;
    const norm = Math.hypot(...mags) || 1;
    return mags.map(v => v / norm);
}

export function radialFourierMagnitudeFromPathData(
    pathData: string,
    bins = 64,
    samples = 256,
    keep = 16
): number[] {
    const sig = radialSignatureFromPathData(pathData, bins, samples);
    return fourierMagnitudeDescriptor(sig, { keep, demean: true, l2Normalize: true });
}

export function l2Normalize(vec: number[]): number[] {
    const n = Math.hypot(...vec) || 1;
    return vec.map(v => v / n);
}

export function cosineSimilarity(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    if (n === 0) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}

export function meanVector(vectors: number[][]): number[] {
    if (vectors.length === 0) return [];
    const dim = vectors[0].length;
    const out = Array.from({ length: dim }, () => 0);
    let count = 0;
    for (const v of vectors) {
        if (v.length !== dim) continue;
        for (let i = 0; i < dim; i++) out[i] += v[i];
        count++;
    }
    if (count === 0) return [];
    for (let i = 0; i < dim; i++) out[i] /= count;
    return l2Normalize(out);
}
