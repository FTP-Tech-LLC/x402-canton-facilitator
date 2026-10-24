# Test fixtures

Not a package. `src/__fixtures__/` holds real MainNet prepared transactions
that the core and facilitator tests decode. They live at this path because
the tests read them from `packages/agent-wallet/src/__fixtures__/`, as in the
upstream monorepo. Prepared but never signed, or already executed: the bytes
authorize nothing.
