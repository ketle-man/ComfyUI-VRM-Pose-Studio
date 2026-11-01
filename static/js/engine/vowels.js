// vowels.js — 音声から母音(あいうえお)を推定する
//
// 20ms ごとに LPC(線形予測)で声道のスペクトル包絡を求め、その山から第1・第2フォルマント(F1 / F2)を取る。
// F1 は口の開き(あ が高く、い・う が低い)、F2 は舌の前後(い が高く、お が低い)にほぼ対応するので、
// 5 母音の代表値との近さを割合(合計 1)にして返す。
// ・話者による声道の長さの違い(男声は低く、女声・子どもは高い)は、ファイル全体の F2 の中央値で補正する
// ・結果は時刻だけで決まる(前フレームの状態を持たない)ので、シークでも書き出しでも同じになる

const RATE = 50;          // 1 秒あたりのフレーム数(analyzeAudioFile の音量と同じ)
const FS = 11025;         // 解析のサンプリング周波数(フォルマントは 4kHz までで足りる)
const WIN = 331;          // 30ms
const ORDER = 14;         // LPC の次数(fs/1000 + 3)
const VISEMES = ["aa", "ih", "ou", "ee", "oh"];
// 日本語の母音の F1 / F2(Hz)。F2 の中央値を 1650Hz にそろえた後の代表値
// (日本語の合成音声 男女 3 声で、そろえた後の値がほぼ一致することを確かめて決めた)
const PROTO = { aa: [830, 1550], ih: [320, 2650], ou: [370, 1520], ee: [500, 2300], oh: [510, 860] };
const PROTO_F2_MEDIAN = 1650;
const TAU = 0.05;         // 近さ → 割合 の温度(小さいほどはっきり 1 つに決まる)

// PCM(FS)の i 番目のフレームの [F1, F2]。無音・判定できないときは null
function formants(pcm, center, buf, r, a, tmp) {
    const start = center - (WIN >> 1);
    if (start < 1 || start + WIN >= pcm.length) return null;
    let energy = 0;
    for (let i = 0; i < WIN; i++) {
        // プリエンファシス(高域を持ち上げて F2 を見やすくする)+ ハミング窓
        const x = pcm[start + i] - 0.97 * pcm[start + i - 1];
        buf[i] = x * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WIN - 1)));
        energy += pcm[start + i] * pcm[start + i];
    }
    if (Math.sqrt(energy / WIN) < 0.02) return null;
    // 自己相関 → Levinson-Durbin
    for (let k = 0; k <= ORDER; k++) {
        let s = 0;
        for (let i = k; i < WIN; i++) s += buf[i] * buf[i - k];
        r[k] = s;
    }
    if (r[0] <= 0) return null;
    r[0] *= 1.0001;
    a.fill(0); a[0] = 1;
    let err = r[0];
    for (let i = 1; i <= ORDER; i++) {
        let acc = r[i];
        for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
        const k = -acc / err;
        tmp.set(a);
        for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
        a[i] = k;
        err *= 1 - k * k;
        if (err <= 0) return null;
    }
    // 包絡 |1/A(e^jw)| を 15Hz 刻みで調べ、山を拾う
    const peaks = [];
    let p2 = 0, p1 = 0;
    for (let f = 150; f <= 3800; f += 15) {
        const w = (2 * Math.PI * f) / FS;
        let re = 0, im = 0;
        for (let k = 0; k <= ORDER; k++) { re += a[k] * Math.cos(w * k); im -= a[k] * Math.sin(w * k); }
        const p = 1 / (re * re + im * im);
        if (f > 180 && p1 > p2 && p1 >= p) peaks.push(f - 15);
        p2 = p1; p1 = p;
    }
    const f1 = peaks.find(f => f >= 200 && f <= 1150);
    if (f1 == null) return null;
    // F1 と F2 が近い(お・う)と山が 1 つに重なることがある。そのときは F2 を低めに見積もる
    const f2 = peaks.find(f => f >= f1 + 250 && f <= 3500) ?? f1 * 1.7;
    return [f1, f2];
}

// file: Blob / File。戻り値 { rate, duration, weights: Float32Array(n * 5) }(無音のフレームは全部 0)。
// scale(話者の補正)と formants(フレームごとの [F1, F2] / null)は確認・調整用
export async function analyzeVowels(file) {
    const ctx = new OfflineAudioContext(1, 1, FS);
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    const pcm = audio.getChannelData(0);
    const n = Math.max(1, Math.ceil(audio.duration * RATE));
    const buf = new Float32Array(WIN), r = new Float64Array(ORDER + 1), a = new Float64Array(ORDER + 1), tmp = new Float64Array(ORDER + 1);
    const fm = new Array(n);
    const f2s = [];
    for (let i = 0; i < n; i++) {
        fm[i] = formants(pcm, Math.round(((i + 0.5) / RATE) * FS), buf, r, a, tmp);
        if (fm[i]) f2s.push(fm[i][1]);
    }
    // 話者の補正: F2 の中央値を基準値に合わせる(極端な値にはしない)
    f2s.sort((x, y) => x - y);
    const scale = f2s.length ? Math.min(1.35, Math.max(0.75, f2s[f2s.length >> 1] / PROTO_F2_MEDIAN)) : 1;

    const raw = new Float32Array(n * 5);
    for (let i = 0; i < n; i++) {
        if (!fm[i]) continue;
        const l1 = Math.log(fm[i][0] / scale), l2 = Math.log(fm[i][1] / scale);
        let sum = 0;
        VISEMES.forEach((v, k) => {
            const d = (l1 - Math.log(PROTO[v][0])) ** 2 + 0.8 * (l2 - Math.log(PROTO[v][1])) ** 2;
            raw[i * 5 + k] = Math.exp(-d / TAU);
            sum += raw[i * 5 + k];
        });
        for (let k = 0; k < 5; k++) raw[i * 5 + k] /= sum || 1;
    }
    // 前後 1 フレームと平均して、母音の細かいばたつきを抑える(無音のフレームは混ぜない)
    const weights = new Float32Array(n * 5);
    for (let i = 0; i < n; i++) {
        if (!fm[i]) continue;
        let cnt = 0;
        for (let j = i - 1; j <= i + 1; j++) {
            if (j < 0 || j >= n || !fm[j]) continue;
            for (let k = 0; k < 5; k++) weights[i * 5 + k] += raw[j * 5 + k];
            cnt++;
        }
        for (let k = 0; k < 5; k++) weights[i * 5 + k] /= cnt;
    }
    return { rate: RATE, duration: audio.duration, scale, weights, voiced: f2s.length, formants: fm };
}

export const VOWEL_VISEMES = VISEMES;
