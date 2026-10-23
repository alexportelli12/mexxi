# Testing

`test-design` decides whether a behaviour earns a test, the break each test
catches, its level and how to see it fail. This reference covers how to test
it in Angular. Use the repository's configured test runner, assertion library,
Angular test setup and naming conventions; do not prescribe Vitest, Jasmine,
Karma or another runner globally.

## Choose the Angular Harness

- Test pure transformations directly without Angular when no framework
  integration is involved.
- Test a service through its public behavior, using `TestBed` when dependency
  injection, providers, or Angular lifecycle are part of the behavior and
  direct construction when they are not.
- Use a component fixture when template rendering, bindings, change
  propagation, DOM interaction, outputs, or injected providers matter. Do not
  use a fixture to test every private calculation.
- Use a feature-level test, with the routes and providers it needs, when the
  break crosses several Angular boundaries.

## Drive Angular Through Its Public Surface

- Treat inputs, user events, rendered states, outputs, and service calls at the
  boundary as a component's contract. Read the closest existing specs before
  choosing setup or test doubles.
- For signal-based state, change it through the public API and assert the
  resulting value or rendered behavior. Trigger the repository's normal
  change-detection or stabilization step when the template requires it.
- Replace HTTP at the `HttpClient` boundary with the repository's testing
  backend or provider, not by stubbing the service under test.
- Keep `TestBed` and fixture setup local enough that each test explains its
  scenario. Reuse helpers only when they preserve that clarity.

## Async Behavior

- Use the async utilities configured by the repository and choose the tool that
  matches the behavior: Angular stabilization for rendering, observable
  assertions for streams, and a fake clock for debounce, polling, timers, or
  delayed work when the configured framework supports it.
- Pair fake-clock setup and cleanup, and avoid real sleeps. Test cancellation,
  duplicate suppression, queueing, and stale-result handling when those are
  product semantics, not merely implementation details.
- Assert the user-visible result and, where it is the contract, the boundary
  interaction (the request parameters or emitted event), never framework
  internals.
