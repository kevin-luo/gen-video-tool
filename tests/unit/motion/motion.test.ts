import {describe, expect, it} from 'vitest';
import {
  compileMotionRecipe,
  getMotionRecipe,
  MOTION_RECIPE_IDS,
  MOTION_RECIPES,
  sampleCamera,
  sampleParallaxFrame,
  sampleBallisticProp,
} from '@gen-video-tool/motion-core';

describe('motion recipe registry', () => {
  it('contains exactly the eight product recipes', () => {
    expect(MOTION_RECIPE_IDS).toEqual([
      'hero-assemble',
      'editorial-pan',
      'number-impact',
      'paper-stack',
      'timeline-travel',
      'comparison-split',
      'quiet-story',
      'detail-reveal',
    ]);
    expect(Object.keys(MOTION_RECIPES)).toHaveLength(8);
  });

  it.each(MOTION_RECIPE_IDS)('%s defines camera, entrances, one emphasis, and an exit', (id) => {
    const recipe = getMotionRecipe(id);
    expect(recipe.camera).toBeDefined();
    expect(recipe.entrances.length).toBeGreaterThan(0);
    expect(recipe.emphasis).toBeDefined();
    expect(recipe.transition).toBeDefined();
    expect(recipe.parallax.background).toBeLessThan(recipe.parallax.subject);
    expect(recipe.parallax.subject).toBeLessThan(recipe.parallax.foreground);
    expect(recipe.parallax.title).toBeLessThan(recipe.parallax.subject);
  });
});

describe('world-aware prop motion', () => {
  const base = {x: 20, y: 700, scaleX: 0.26, scaleY: 0.26, rotation: 0};
  const kick = {contactFrame: 12, flightFrames: 30, targetX: 90, targetY: -260, targetScale: 0.14, curveX: 24, spinDegrees: 420};

  it('keeps the ball planted before foot contact', () => {
    expect(sampleBallisticProp(kick, 0, base)).toEqual(base);
    expect(sampleBallisticProp(kick, 11, base)).toEqual(base);
  });

  it('moves only after contact and reaches the configured goal-side target', () => {
    expect(sampleBallisticProp(kick, 13, base).y).toBeLessThan(base.y);
    expect(sampleBallisticProp(kick, 42, base)).toMatchObject({x: 90, y: -260, scaleX: 0.14, scaleY: 0.14, rotation: 420});
  });
});
describe('deterministic recipe compiler', () => {
  it('returns byte-stable values for the same inputs', () => {
    const options = {
      recipeId: 'hero-assemble' as const,
      durationFrames: 173,
      fps: 30,
      aspectRatio: '9:16' as const,
    };
    expect(JSON.stringify(compileMotionRecipe(options))).toBe(JSON.stringify(compileMotionRecipe(options)));
  });

  it('does not add idle motion by default', () => {
    const plan = compileMotionRecipe({recipeId: 'quiet-story'});
    expect(plan.events.some((event) => event.kind === 'idle')).toBe(false);
  });

  it('adds at most one subtle subject idle only when explicitly enabled', () => {
    const plan = compileMotionRecipe({recipeId: 'quiet-story', enableIdle: true});
    const idle = plan.events.filter((event) => event.kind === 'idle');
    expect(idle.length).toBeLessThanOrEqual(1);
    if (idle[0]) {
      expect(idle[0]).toMatchObject({targetRole: 'subject', animation: 'microDrift'});
    }
  });

  it.each(['number-impact', 'comparison-split'] as const)(
    'keeps %s impactShake inside the 6-12 frame window',
    (recipeId) => {
      const plan = compileMotionRecipe({recipeId});
      const impact = plan.events.find((event) => event.animation === 'impactShake');
      expect(impact).toBeDefined();
      expect(impact?.durationFrames).toBeGreaterThanOrEqual(6);
      expect(impact?.durationFrames).toBeLessThanOrEqual(12);
    },
  );

  it('adapts fixed camera travel to aspect ratio without AI coordinates', () => {
    const vertical = compileMotionRecipe({recipeId: 'timeline-travel', aspectRatio: '9:16'});
    const landscape = compileMotionRecipe({recipeId: 'timeline-travel', aspectRatio: '16:9'});
    expect(Math.abs(vertical.camera.x)).toBeLessThan(Math.abs(landscape.camera.x));
    expect(vertical.events.every((event) => Number.isInteger(event.startFrame))).toBe(true);
    expect(vertical.events.every((event) => Number.isInteger(event.durationFrames))).toBe(true);
  });

  it('clamps every compiled event to the shot duration', () => {
    const plan = compileMotionRecipe({recipeId: 'hero-assemble', durationFrames: 9});
    expect(
      plan.events.every(
        (event) => event.startFrame >= 0 && event.startFrame + event.durationFrames <= plan.durationFrames,
      ),
    ).toBe(true);
  });
});

describe('true per-layer depth parallax', () => {
  it('moves foreground more than subject, and subject more than background', () => {
    const plan = compileMotionRecipe({recipeId: 'editorial-pan', durationFrames: 120});
    const samples = sampleParallaxFrame(plan, 119, [
      {id: 'bg', role: 'background', depth: 0.5},
      {id: 'subject', role: 'subject', depth: 0.5},
      {id: 'fg', role: 'foreground', depth: 0.5},
    ]);
    const distance = (id: string) => Math.abs(samples.find((sample) => sample.layerId === id)?.x ?? 0);
    expect(distance('bg')).toBeLessThan(distance('subject'));
    expect(distance('subject')).toBeLessThan(distance('fg'));
  });

  it('keeps title text nearly screen-locked even with maximum depth', () => {
    const plan = compileMotionRecipe({recipeId: 'editorial-pan', durationFrames: 120});
    const samples = sampleParallaxFrame(plan, 119, [
      {id: 'title', role: 'title', depth: 1},
      {id: 'subject', role: 'subject', depth: 0.1},
    ]);
    const title = samples.find((sample) => sample.layerId === 'title');
    const subject = samples.find((sample) => sample.layerId === 'subject');
    expect(Math.abs(title?.x ?? 0)).toBeLessThan(Math.abs(subject?.x ?? 0));
    expect(Math.abs((title?.scale ?? 1) - 1)).toBeLessThan(Math.abs((subject?.scale ?? 1) - 1));
  });

  it('samples camera start and end deterministically', () => {
    const plan = compileMotionRecipe({recipeId: 'detail-reveal', durationFrames: 100});
    expect(sampleCamera(plan.camera, 0, 100)).toEqual({x: 0, y: 0, scale: 1.11});
    expect(sampleCamera(plan.camera, 99, 100)).toEqual({
      x: plan.camera.x,
      y: plan.camera.y,
      scale: plan.camera.scaleTo,
    });
  });
});
