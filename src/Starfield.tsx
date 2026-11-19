import { useEffect, useRef } from "react";

interface Star {
  x: number;
  y: number;
  // 0 = far, 1 = near. Drives size, brightness, and drift speed.
  depth: number;
  radius: number;
  speed: number;
  alpha: number;
  twinkleRate: number;
  phase: number;
  // Eased displacement caused by the pointer, in pixels.
  offsetX: number;
  offsetY: number;
}

// Pointer influence radius in pixels. Stars outside it are unaffected.
const INFLUENCE_PX = 110;
// Maximum push away from the pointer, in pixels, at the centre of the influence.
const PUSH_PX = 10;
// Extra brightness added to a star at the pointer centre (0 to 1).
const GLOW = 0.5;
// How quickly a star's displacement and glow follow the pointer (0 to 1 per frame).
const EASE = 0.08;
// Redraw rate cap. Stars move at most ~20 px/s, so 30 fps looks smooth and halves the work
// of a 60 Hz loop. Movement uses real elapsed time, so the speed does not change.
const FRAME_MS = 1000 / 30;
// Stars are 1 to 2 px dots; a bitmap above 1x DPR costs far more pixels to clear and
// composite without a visible gain.
const MAX_DPR = 1;

// Slow drifting starfield on a canvas behind the window content. Stars near the cursor glow
// slightly and drift a few pixels away, then settle back. Respects prefers-reduced-motion by
// drawing one static frame with no drift or pointer reaction.
export function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let stars: Star[] = [];
    let raf = 0;
    let running = false;
    let last = performance.now();
    // Pointer position in canvas coordinates, or null when outside the window.
    let pointer: { x: number; y: number } | null = null;

    const spawn = (): Star => {
      const depth = Math.random();
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        depth,
        radius: 0.4 + depth * 1.1,
        speed: 4 + depth * 16,
        alpha: 0.25 + depth * 0.6,
        twinkleRate: 0.6 + Math.random() * 1.6,
        phase: Math.random() * Math.PI * 2,
        offsetX: 0,
        offsetY: 0,
      };
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // About one star per 9000 px^2, capped so the frame stays cheap. Existing stars are kept
      // so a resize does not reshuffle the field.
      const count = Math.min(160, Math.round((width * height) / 9000));
      if (stars.length > count) stars.length = count;
      while (stars.length < count) stars.push(spawn());
      if (reduceMotion) draw(performance.now());
    };

    // Influence of the pointer on a star: 1 at the pointer, 0 at INFLUENCE_PX and beyond.
    const influenceOf = (star: Star): { influence: number; dx: number; dy: number } => {
      if (!pointer) return { influence: 0, dx: 0, dy: 0 };
      const dx = star.x - pointer.x;
      const dy = star.y - pointer.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= INFLUENCE_PX) return { influence: 0, dx, dy };
      return { influence: 1 - dist / INFLUENCE_PX, dx, dy };
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#ddd6fe";
      for (const star of stars) {
        const twinkle = 0.7 + 0.3 * Math.sin(now * 0.001 * star.twinkleRate + star.phase);
        const { influence } = influenceOf(star);
        const glow = influence * GLOW;
        ctx.globalAlpha = Math.min(1, star.alpha * twinkle + glow);
        ctx.beginPath();
        ctx.arc(
          star.x + star.offsetX,
          star.y + star.offsetY,
          star.radius + glow * 0.8,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const elapsed = now - last;
      // Skip frames that come before the 30 fps interval. The few ms of tolerance stop
      // display-clock jitter from dropping a frame that is almost on time.
      if (elapsed < FRAME_MS - 4) return;
      const dt = Math.min(elapsed / 1000, 0.05);
      last = now;
      for (const star of stars) {
        // Drift down and to the left, wrapping at the edges
        star.x -= star.speed * dt;
        star.y += star.speed * 0.25 * dt;
        if (star.x < -2) star.x = width + 2;
        if (star.y > height + 2) star.y = -2;

        // Target push: directly away from the pointer, strongest at its centre
        const { influence, dx, dy } = influenceOf(star);
        const dist = Math.hypot(dx, dy);
        let targetX = 0;
        let targetY = 0;
        if (influence > 0 && dist > 0.001) {
          const push = influence * PUSH_PX;
          targetX = (dx / dist) * push;
          targetY = (dy / dist) * push;
        }
        star.offsetX += (targetX - star.offsetX) * EASE;
        star.offsetY += (targetY - star.offsetY) * EASE;
      }
      draw(now);
    };

    const onMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    // Pointer left the window: stars settle back
    const onLeave = (event: MouseEvent) => {
      if (event.relatedTarget === null) pointer = null;
    };

    // Animate only while the window is shown and focused. A hidden, minimized, or unfocused
    // window keeps its last frame on the canvas, so it looks still and costs nothing.
    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const sync = () => {
      if (!document.hidden && document.hasFocus()) start();
      else stop();
    };

    // Watch the canvas itself: the vault box grows with a CSS transition, which does not fire
    // the window resize event, and a stale bitmap size stretches the stars into ovals.
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    if (!reduceMotion) {
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseout", onLeave);
      document.addEventListener("visibilitychange", sync);
      window.addEventListener("focus", sync);
      window.addEventListener("blur", sync);
      sync();
    }

    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);

  return <canvas className="starfield" ref={canvasRef} aria-hidden="true" />;
}
