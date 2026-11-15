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
      const dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // About one star per 9000 px^2, capped so the frame stays cheap
      const count = Math.min(160, Math.round((width * height) / 9000));
      stars = Array.from({ length: count }, spawn);
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
      const dt = Math.min((now - last) / 1000, 0.05);
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
      raf = requestAnimationFrame(frame);
    };

    const onMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    // Pointer left the window: stars settle back
    const onLeave = (event: MouseEvent) => {
      if (event.relatedTarget === null) pointer = null;
    };

    resize();
    window.addEventListener("resize", resize);
    if (!reduceMotion) {
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseout", onLeave);
      raf = requestAnimationFrame(frame);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
    };
  }, []);

  return <canvas className="starfield" ref={canvasRef} aria-hidden="true" />;
}
