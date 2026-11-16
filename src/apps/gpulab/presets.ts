/** Fragment-shader presets. Each is the body the user edits: helpers plus `fn mainImage`. */

export interface ShaderPreset {
  id: string;
  name: string;
  code: string;
}

const plasma = `// Classic plasma: a sum of sine waves fed through a cosine palette.
fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * u.resolution) / u.resolution.y;
  let t = u.time * 0.6;
  var v = sin(uv.x * 6.0 + t);
  v += sin((uv.y * 6.0 + t) * 0.7);
  v += sin((uv.x + uv.y) * 5.0 + t * 1.3);
  let c = uv + 0.5 * vec2f(sin(t * 0.33), cos(t * 0.5));
  v += sin(sqrt(dot(c, c) * 80.0 + 1.0) + t);
  let col = 0.5 + 0.5 * cos(vec3f(0.0, 2.1, 4.2) + v * 1.2 + t * 0.2);
  return vec4f(col, 1.0);
}
`;

const raymarch = `// Raymarched SDF scene: a wobbling sphere over a checkered floor.
// Drag horizontally to orbit the camera.
fn sdScene(p: vec3f) -> f32 {
  let wobble = 0.08 * sin(p.x * 6.0 + u.time * 2.0) * sin(p.y * 6.0) * sin(p.z * 6.0);
  let sphere = length(p) - 1.0 + wobble;
  let floorPlane = p.y + 1.2;
  return min(sphere, floorPlane);
}

fn calcNormal(p: vec3f) -> vec3f {
  let e = vec2f(0.001, 0.0);
  return normalize(vec3f(
    sdScene(p + e.xyy) - sdScene(p - e.xyy),
    sdScene(p + e.yxy) - sdScene(p - e.yxy),
    sdScene(p + e.yyx) - sdScene(p - e.yyx)));
}

fn softShadow(p: vec3f, l: vec3f) -> f32 {
  var sh = 1.0;
  var t = 0.02;
  for (var i = 0; i < 32; i++) {
    let d = sdScene(p + l * t);
    sh = min(sh, 8.0 * d / t);
    t += clamp(d, 0.02, 0.2);
    if (d < 0.001 || t > 8.0) { break; }
  }
  return clamp(sh, 0.0, 1.0);
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * u.resolution) / u.resolution.y;
  let a = u.time * 0.3 + u.mouse.x / max(u.resolution.x, 1.0) * 6.2831;
  let ro = vec3f(3.5 * sin(a), 1.0, 3.5 * cos(a));
  let fw = normalize(-ro);
  let rt = normalize(cross(fw, vec3f(0.0, 1.0, 0.0)));
  let up = cross(rt, fw);
  let rd = normalize(fw * 1.6 + rt * uv.x + up * uv.y);

  let sky = mix(vec3f(0.55, 0.65, 0.9), vec3f(0.12, 0.14, 0.3), clamp(uv.y + 0.5, 0.0, 1.0));
  var t = 0.0;
  var hit = false;
  for (var i = 0; i < 96; i++) {
    let d = sdScene(ro + rd * t);
    if (d < 0.001) { hit = true; break; }
    t += d;
    if (t > 20.0) { break; }
  }
  var col = sky;
  if (hit) {
    let p = ro + rd * t;
    let n = calcNormal(p);
    let l = normalize(vec3f(0.6, 0.8, 0.4));
    let dif = max(dot(n, l), 0.0);
    let sh = softShadow(p + n * 0.002, l);
    var base = vec3f(0.9, 0.35, 0.2);
    if (p.y < -1.19) {
      let chk = abs((floor(p.x) + floor(p.z)) % 2.0);
      base = mix(vec3f(0.25), vec3f(0.8), chk);
    }
    let spec = pow(max(dot(reflect(-l, n), -rd), 0.0), 32.0);
    col = base * (0.15 + 0.85 * dif * sh) + vec3f(spec * sh * 0.6);
    col = mix(col, sky, 1.0 - exp(-0.02 * t * t));
  }
  return vec4f(pow(col, vec3f(0.4545)), 1.0);
}
`;

const mandelbrot = `// Mandelbrot set with a slow, looping zoom into Seahorse Valley.
fn mainImage(fragCoord: vec2f) -> vec4f {
  let uv = (fragCoord - 0.5 * u.resolution) / u.resolution.y;
  let zoom = pow(0.5, 12.0 * (0.5 - 0.5 * cos(u.time * 0.12)));
  let c = vec2f(-0.743643887, 0.131825904) + uv * 2.5 * zoom;
  var z = vec2f(0.0);
  var n = 0;
  for (; n < 400; n++) {
    z = vec2f(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 256.0) { break; }
  }
  if (n >= 400) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  // Smooth iteration count removes banding.
  let sn = f32(n) - log2(log2(dot(z, z))) + 4.0;
  let col = 0.5 + 0.5 * cos(3.0 + sn * 0.15 + vec3f(0.0, 0.6, 1.0));
  return vec4f(col, 1.0);
}
`;

const voronoi = `// Animated Voronoi cells. Hover to highlight a cell.
fn hash2(p: vec2f) -> vec2f {
  let q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}

fn mainImage(fragCoord: vec2f) -> vec4f {
  let scale = 6.0;
  let uv = fragCoord / u.resolution.y * scale;
  let cell = floor(uv);
  let f = fract(uv);
  var d1 = 8.0;
  var d2 = 8.0;
  var id = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2f(f32(x), f32(y));
      let o = 0.5 + 0.5 * sin(u.time + 6.2831 * hash2(cell + g));
      let r = g + o - f;
      let d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; id = cell + g; } else if (d < d2) { d2 = d; }
    }
  }
  let edge = sqrt(d2) - sqrt(d1);
  var col = 0.5 + 0.5 * cos(6.2831 * hash2(id).x + vec3f(0.0, 2.0, 4.0));
  col *= 0.75 + 0.25 * sqrt(d1);
  let m = floor(u.mouse / u.resolution.y * scale);
  if (all(id == m)) { col = mix(col, vec3f(1.0), 0.35); }
  col *= smoothstep(0.0, 0.08, edge);
  col += vec3f(1.0 - smoothstep(0.0, 0.05, sqrt(d1)));
  return vec4f(col, 1.0);
}
`;

const tunnel = `// Infinite tunnel: polar coordinates mapped onto a scrolling texture.
fn mainImage(fragCoord: vec2f) -> vec4f {
  let p = (fragCoord - 0.5 * u.resolution) / u.resolution.y;
  let r = max(length(p), 0.001);
  let a = atan2(p.y, p.x) / 3.14159265;
  let depth = 0.3 / r + u.time * 0.8;
  let twist = a + 0.1 * sin(depth * 0.7 + u.time);
  let checker = step(0.5, fract(depth * 2.0)) * step(0.5, fract(twist * 4.0))
              + (1.0 - step(0.5, fract(depth * 2.0))) * (1.0 - step(0.5, fract(twist * 4.0)));
  let hue = 0.5 + 0.5 * cos(vec3f(0.0, 1.0, 2.0) + depth * 0.4);
  let col = hue * (0.45 + 0.55 * checker);
  let fog = smoothstep(0.0, 0.7, r);
  return vec4f(col * fog, 1.0);
}
`;

export const SHADER_PRESETS: ShaderPreset[] = [
  { id: 'plasma', name: 'Plasma', code: plasma },
  { id: 'raymarch', name: 'Raymarched SDF', code: raymarch },
  { id: 'mandelbrot', name: 'Mandelbrot zoom', code: mandelbrot },
  { id: 'voronoi', name: 'Voronoi', code: voronoi },
  { id: 'tunnel', name: 'Tunnel', code: tunnel },
];
