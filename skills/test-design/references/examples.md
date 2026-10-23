# Test Design Examples

One short bad and good pair per rule in `SKILL.md`. The examples use Vitest's
API; translate them to the repository's runner and conventions.

## Does It Earn A Test?

**Types already prevent it.**

```ts
// Bad: the compiler already guarantees this.
it("returns a string", () => {
  expect(typeof formatPrice(1999)).toBe("string");
});

// Good: the behaviour has an independent truth (the spec's currency format).
it("formats cents as euros with two decimals", () => {
  expect(formatPrice(1999)).toBe("€19.99");
});
```

**Trivial unit: test it through its consumer.**

```ts
// Bad: restates a getter.
it("exposes the customer's name", () => {
  expect(new Customer("Ana").name).toBe("Ana");
});

// Good: the behaviour that uses it.
it("lists customers alphabetically by name", () => {
  const sorted = sortCustomers([new Customer("Zoe"), new Customer("Ana")]);
  expect(sorted.map((customer) => customer.name)).toEqual(["Ana", "Zoe"]);
});
```

**Wiring, config and copy: no test.**

```ts
// Bad: a change detector for a route table.
it("registers the settings route", () => {
  expect(routes.find((r) => r.path === "settings")?.component).toBe(SettingsPage);
});

// Good: no test of the table. If reaching settings is a risky flow, one test
// of the flow sees the break, at the level the flow needs.
```

## Plan From Named Breaks

**Name the break, and whether it is a bug.**

```ts
// Bad: no break named. It goes red if the copy changes, a deliberate decision.
it("shows the empty state", () => {
  expect(screen.getByText("No invoices yet. Create your first one!")).toBeVisible();
});

// Good. Break: the list renders nothing (a bug) when the API returns [].
it("offers to create an invoice when there are none", () => {
  renderInvoices({ invoices: [] });
  expect(screen.getByRole("button", { name: /create/i })).toBeVisible();
});
```

**Highest seam, cheapest level, one level per break.**

```ts
// Bad: reaches past the seam into a private helper, and the same discount
// rule is asserted again in a component test and an E2E test.
it("applyTier returns 0.1 for gold", () => {
  expect((cart as any).applyTier("gold")).toBe(0.1);
});

// Good: the public interface, once, at unit level.
it("gives gold members 10% off", () => {
  expect(priceCart({ items: [item(100)], tier: "gold" }).total).toBe(90);
});
```

**List the real side effects before mocking.**

```ts
// Bad: the double drops the audit write the real save() performs.
repo.save = vi.fn().mockResolvedValue(undefined);

// Good: an in-memory substitute that keeps the behaviour that matters, read
// back through the repository's own read path.
const repo = new InMemoryOrderRepo();
await placeOrder(repo, order({ id: "o-1" }));
expect(await repo.history("o-1")).toEqual([{ action: "order.placed" }]);
```

## Write Tests That Can Fail

**Drive the real interface.**

```ts
// Bad: sets internal state, then reads it back.
component.state.items = [item()];
expect(component.state.items.length).toBe(1);

// Good: act as the user, assert what the user sees.
await user.click(screen.getByRole("button", { name: "Add to cart" }));
expect(screen.getByRole("status")).toHaveTextContent("1 item");
```

**Literal or spec-derived expectations (no mirror assertion).**

```ts
// Bad: computes the expectation the way the code does; agrees with any bug.
expect(vat(200)).toBe(200 * VAT_RATE);

// Good: the number comes from the spec (18% VAT on €200).
expect(vat(200)).toBe(36);
```

**Assert the contract, no less and no more.**

```ts
// Bad (less): passes even if the wrong user is loaded.
expect(await loadUser("u-1")).toBeDefined();

// Bad (more): breaks on any harmless markup change.
expect(container.innerHTML).toMatchSnapshot();

// Good.
expect(await loadUser("u-1")).toMatchObject({ id: "u-1", email: "a@example.com" });
```

**Mock only at boundaries; the mock earns an assertion only when the call is
the contract.**

```ts
// Bad: asserts the stub returned what the test told it to.
pricing.quote = vi.fn().mockReturnValue(42);
expect(pricing.quote()).toBe(42);

// Good: the outbound charge is the contract, so asserting it means something.
await checkout(cart(90), { payments });
expect(payments.charge).toHaveBeenCalledOnce();
expect(payments.charge).toHaveBeenCalledWith({ amount: 9000, currency: "EUR" });
```

**Pair every "not called" assertion.**

```ts
// Bad alone: also passes if sending emails is broken everywhere.
it("does not email unverified users", async () => {
  await notify(user({ verified: false }), { mailer });
  expect(mailer.send).not.toHaveBeenCalled();
});

// Good: the pair proves the test can tell the difference.
it("emails verified users", async () => {
  await notify(user({ verified: true }), { mailer });
  expect(mailer.send).toHaveBeenCalledOnce();
});
```

**Verify through the interface, not a side channel.**

```ts
// Bad: checks a log line rather than the behaviour.
await api.post("/orders", body);
expect(logger.info).toHaveBeenCalledWith("order created");

// Good: read it back the way a client would.
const { id } = await api.post("/orders", body);
expect(await api.get(`/orders/${id}`)).toMatchObject({ status: "pending" });
```

**Deterministic.**

```ts
// Bad: a real sleep past the one-hour lifetime, shrunk with a test-only option.
const session = startSession({ lifetimeMs: 1000 });
await new Promise((r) => setTimeout(r, 1100));
expect(session.isExpired()).toBe(true);

// Good: control the clock and keep the real lifetime.
vi.useFakeTimers();
const session = startSession();
vi.advanceTimersByTime(60 * 60 * 1000 + 1);
expect(session.isExpired()).toBe(true);
```

**No test-only production code.**

```ts
// Bad: production exports a reset only the tests call.
export function __resetCacheForTests() { cache.clear(); }

// Good: each test builds its own instance through the real constructor.
const prices = createPriceCache();
```

**Name tests after capabilities.**

```ts
// Bad.
it("calls calculateDiscount", ...);
it("works", ...);

// Good.
it("applies the loyalty discount to orders over €100", ...);
```

## See Each New Test Fail

**Bug fix: red on the unfixed code.**

```text
Bad:  write the fix and the test together; the test passes; ship it.
Good: revert the fix, run the focused test, see
      "expected 90, received 100" (the reported bug), restore the fix, see green.
```

**The two-edit check.**

```text
Test: "gives gold members 10% off"
Edit 1, break the behaviour: change the gold rate to 0.  -> must go red.
Edit 2, change only the internals: replace the tier switch with a lookup
        table giving the same rates.                       -> must stay green.
A test that stays green on edit 1 protects nothing. A test that goes red on
edit 2 (for example one that spies on the private switch) is a change detector.
```

## Report What The Tests Prove

```text
Bad:  "Added 14 tests; coverage up from 71% to 83%."
Good: "Cart total: rejects discounts that would make it negative (seen red
       by removing the floor). Gold tier: 10% off (seen red test-first).
       Not tested: the new button label (copy)."
```

## Audit An Existing Suite

```text
Bad:  "Deleted 40 low-value tests while adding the feature."
Good (report only, one area):
| Test | Claimed break | Verdict | Evidence |
| --- | --- | --- | --- |
| cart.spec.ts › "has items" | an added item is lost | delete | Reads a getter; "adds an item to the cart" catches the same break through the interface |
| cart.spec.ts › "totals" | wrong total | rewrite | Expected value computed with the code's formula |
```
