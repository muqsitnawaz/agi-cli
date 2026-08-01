import { describe, it, expect } from 'vitest';
import { computeActor, actorEnv, type ResolvedActor } from './actor.js';

describe('computeActor', () => {
  it('inherits an actor an ancestor stamped into the env, without re-resolving', () => {
    const env: NodeJS.ProcessEnv = {
      AGENTS_ACTOR: 'bisma@example.com',
      AGENTS_ACTOR_KIND: 'human',
      AGENTS_ACTOR_NAME: 'Bisma',
      AGENTS_ACTOR_EMAIL: 'bisma@example.com',
      AGENTS_ACTOR_GITHUB: 'bisma',
      // An SSH_CONNECTION is present but must be ignored: inheritance wins so the
      // whole spawn tree shares one actor and we never shell out again.
      SSH_CONNECTION: '100.64.0.9 51000 100.64.0.1 22',
    };
    expect(computeActor(env)).toEqual<ResolvedActor>({
      id: 'bisma@example.com',
      kind: 'human',
      name: 'Bisma',
      email: 'bisma@example.com',
      github: 'bisma',
    });
  });

  it('inherits kind=agent verbatim', () => {
    const actor = computeActor({ AGENTS_ACTOR: 'scout', AGENTS_ACTOR_KIND: 'agent' });
    expect(actor.id).toBe('scout');
    expect(actor.kind).toBe('agent');
  });

  it('falls back to UNRESOLVED@<host> for a local (non-SSH) run', () => {
    const actor = computeActor({});
    expect(actor.id).toMatch(/^UNRESOLVED@/);
    expect(actor.kind).toBe('human');
    expect(actor.email).toBeUndefined();
    expect(actor.name).toBeUndefined();
  });

  it('does not shell out when SSH_CONNECTION is malformed (no client ip)', () => {
    const actor = computeActor({ SSH_CONNECTION: 'garbage' });
    expect(actor.id).toMatch(/^UNRESOLVED@/);
  });
});

describe('actorEnv', () => {
  it('credits git for a resolved human with a real name + email', () => {
    const env = actorEnv({
      id: 'muqsitnawaz@gmail.com',
      kind: 'human',
      name: 'Muqsit',
      email: 'muqsitnawaz@gmail.com',
    });
    expect(env.AGENTS_ACTOR).toBe('muqsitnawaz@gmail.com');
    expect(env.AGENTS_ACTOR_KIND).toBe('human');
    expect(env.GIT_AUTHOR_NAME).toBe('Muqsit');
    expect(env.GIT_AUTHOR_EMAIL).toBe('muqsitnawaz@gmail.com');
    expect(env.GIT_COMMITTER_NAME).toBe('Muqsit');
    expect(env.GIT_COMMITTER_EMAIL).toBe('muqsitnawaz@gmail.com');
  });

  it('claims no git identity for an unresolved actor (keeps ambient git config)', () => {
    const env = actorEnv({ id: 'UNRESOLVED@zion', kind: 'human' });
    expect(env.AGENTS_ACTOR).toBe('UNRESOLVED@zion');
    expect(env.AGENTS_ACTOR_KIND).toBe('human');
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(env.GIT_COMMITTER_NAME).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  it('does not give a non-human actor personal git credit', () => {
    const env = actorEnv({ id: 'scout', kind: 'agent', name: 'Scout', email: 'scout@bot' });
    expect(env.AGENTS_ACTOR_KIND).toBe('agent');
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
  });

  it('round-trips through the env: actorEnv output re-inherits to the same actor', () => {
    const actor: ResolvedActor = {
      id: 'bisma@example.com',
      kind: 'human',
      name: 'Bisma',
      email: 'bisma@example.com',
      github: 'bisma',
    };
    expect(computeActor(actorEnv(actor))).toEqual(actor);
  });
});
