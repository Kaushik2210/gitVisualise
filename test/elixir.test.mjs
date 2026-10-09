// Elixir import graph: alias / import / require / use resolve to the file that defines the module; nothing is guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { elixirModules, elixirImports, parseMix } from '../skills/repo-architecture/scripts/lib/core/lang-elixir.mjs';
import { scanRepo } from '../skills/repo-architecture/scripts/lib/scan.mjs';
import { generate } from '../skills/repo-architecture/scripts/lib/generate.mjs';
import { validate } from '../skills/repo-architecture/scripts/lib/validate.mjs';
import { repo, imports, externals } from './helpers.mjs';

test('elixir: nested defmodule gets its enclosing module as a prefix, and docstrings and comments hold no code', () => {
  const src = [
    'defmodule MyApp.Accounts do',
    '  @moduledoc """',
    '  defmodule Fake.InDoc do',
    '  alias Not.Real',
    '  """',
    '  # defmodule Commented do',
    '  defmodule User do',
    '    defmodule Profile do',
    '    end',
    '  end',
    'end',
    'defmodule Other do',
    'end',
  ].join('\n');
  assert.deepEqual(elixirModules(src).map((m) => [m.name, m.line]), [['MyApp.Accounts', 1], ['MyApp.Accounts.User', 7], ['MyApp.Accounts.User.Profile', 8], ['Other', 12]]);
  assert.deepEqual(elixirImports(src), [], 'the alias inside the heredoc is documentation, not an import');
});

test('elixir: every directive form, the multi-alias form across lines, and __MODULE__', () => {
  const src = [
    'defmodule MyApp.Web do',
    '  alias MyApp.Repo',
    '  alias MyApp.Accounts.User, as: U',
    '  import MyApp.Helpers',
    '  require Logger',
    '  use MyApp.Schema, table: "x"',
    '  alias MyApp.{Billing, Accounts.Plan}',
    '  alias MyApp.Deep.{',
    '    One,',
    '    Two',
    '  }',
    '  alias __MODULE__.Child',
    'end',
  ].join('\n');
  assert.deepEqual(elixirImports(src).map((i) => [i.spec, i.line]), [
    ['MyApp.Repo', 2], ['MyApp.Accounts.User', 3], ['MyApp.Helpers', 4], ['Logger', 5], ['MyApp.Schema', 6],
    ['MyApp.Billing', 7], ['MyApp.Accounts.Plan', 7], ['MyApp.Deep.One', 8], ['MyApp.Deep.Two', 8], ['MyApp.Web.Child', 12],
  ]);
});

test('elixir: mix.exs dependencies and entry modules are read from the right places', () => {
  const mix = [
    'defmodule MyApp.MixProject do',
    '  def project, do: [app: :my_app, deps: deps()]',
    '  def application, do: [mod: {MyApp.Application, []}]',
    '  defp deps do',
    '    [',
    '      {:phoenix, "~> 1.7"},',
    '      {:plug_cowboy, "~> 2.0", only: :prod},',
    '      {:jason, git: "https://github.com/x/jason"}',
    '    ]',
    '  end',
    'end',
  ].join('\n');
  const { deps, entries } = parseMix(mix);
  assert.deepEqual(deps.map((d) => [d.name, d.version, d.line]), [['phoenix', '~> 1.7', 6], ['plug_cowboy', '~> 2.0', 7], ['jason', null, 8]]);
  assert.deepEqual([...entries], ['MyApp.Application']);
  assert.deepEqual(parseMix('defmodule X do\nend\n').deps, [], 'no deps function, no deps (a stray tuple elsewhere is not one)');
});

const app = () => repo({
  'mix.exs': 'defmodule MyApp.MixProject do\n  def application, do: [mod: {MyApp.Application, []}]\n  defp deps do\n    [{:phoenix, "~> 1.7"}, {:ecto_sql, "~> 3.0"}, {:unused_dep, "~> 1.0"}]\n  end\nend\n',
  'lib/my_app/application.ex': 'defmodule MyApp.Application do\n  use Application\n  alias MyApp.Repo\n  alias MyApp.Accounts\n  def start(_t, _a), do: Supervisor.start_link([Repo], strategy: :one_for_one)\nend\n',
  'lib/my_app/repo.ex': 'defmodule MyApp.Repo do\n  use Ecto.Repo, otp_app: :my_app\nend\n',
  'lib/my_app/accounts.ex': 'defmodule MyApp.Accounts do\n  alias MyApp.Accounts.User\n  alias MyApp.{Repo, Missing}\n  import Phoenix.Controller\n  require Logger\n  alias Enum.Thing\nend\n',
  'lib/my_app/accounts/user.ex': 'defmodule MyApp.Accounts.User do\n  use Ecto.Schema\nend\n',
  'lib/mix/tasks/seed.ex': 'defmodule Mix.Tasks.Seed do\n  use Mix.Task\nend\n',
  'config/config.exs': 'import Config\nconfig :my_app, key: 1\n',
});

test('elixir: imports resolve to files that define the module; the standard library, missing modules and undeclared packages are dropped', () => {
  const scan = scanRepo(app());
  const resolved = (file) => Object.fromEntries(Object.entries(imports(scan, file)).filter(([, v]) => v));
  assert.deepEqual(resolved('lib/my_app/application.ex'), { 'MyApp.Repo': 'lib/my_app/repo.ex', 'MyApp.Accounts': 'lib/my_app/accounts.ex' }, 'use Application is OTP, not a project module');
  const acc = imports(scan, 'lib/my_app/accounts.ex');
  assert.equal(acc['MyApp.Accounts.User'], 'lib/my_app/accounts/user.ex');
  assert.equal(acc['MyApp.Repo'], 'lib/my_app/repo.ex');
  assert.equal(acc['MyApp.Missing'] || null, null, 'no file defines it');
  assert.equal(acc['Logger'] || null, null, 'standard library');
  assert.equal(acc['Enum.Thing'] || null, null);
  assert.equal(acc['Phoenix.Controller'] || null, null, 'a declared dependency is external, not a file');
});

test('elixir: a dependency becomes an external node only when something imports it, matched by its atom', () => {
  const scan = scanRepo(app());
  const names = externals(scan);
  assert.ok(names.includes('phoenix'), 'import Phoenix.Controller -> :phoenix');
  assert.ok(!names.includes('unused_dep'), 'declared but never imported');
  assert.ok(!names.includes('config'), 'import Config is not a dependency');
});

test('elixir: the OTP application named in mix.exs and Mix tasks are entry points; the graph generates and validates', () => {
  const root = app();
  const scan = scanRepo(root);
  const reasons = Object.fromEntries(scan.entryPoints.map((e) => [e.path, e.reason]));
  assert.match(reasons['lib/my_app/application.ex'], /MyApp\.Application/);
  assert.equal(reasons['lib/mix/tasks/seed.ex'], 'Mix task');
  const arch = generate(scan);
  assert.ok(arch.edges.some((e) => e.kind === 'imports'), 'import edges exist');
  assert.deepEqual(validate(arch, root).errors, []);
  assert.ok(scan.stats.languages.Elixir >= 5, JSON.stringify(scan.stats.languages));
});

test('elixir: an edge whose only evidence is an `alias` line is accepted by the validator as an import', () => {
  const root = repo({
    'mix.exs': 'defmodule MyApp.MixProject do\n  def application, do: [mod: {MyApp.Application, []}]\nend\n',
    'lib/application.ex': 'defmodule MyApp.Application do\n  alias MyApp.Worker\n  def start, do: Worker.run()\nend\n',
    'lib/worker.ex': 'defmodule MyApp.Worker do\n  def run, do: :ok\nend\n',
  });
  const arch = generate(scanRepo(root));
  const edge = arch.edges.find((e) => e.kind === 'imports');
  assert.ok(edge, 'application -> worker');
  const r = validate(arch, root);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, [], 'no "does not look like an import" warning for alias');
});

test('elixir: a dependency matches its module by the whole atom, ignoring underscores (Phoenix.PubSub <- :phoenix_pubsub), and never by a prefix', () => {
  const root = repo({
    'mix.exs': 'defmodule MyApp.MixProject do\n  defp deps do\n    [{:phoenix_pubsub, "~> 2.0"}, {:plug_cowboy, "~> 2.0"}]\n  end\nend\n',
    'lib/a.ex': 'defmodule A do\n  alias Phoenix.PubSub\n  alias Phoenix.Socket\n  alias Plug.Cowboy\n  alias PlugCowboy\nend\n',
  });
  const names = externals(scanRepo(root));
  assert.ok(names.includes('phoenix_pubsub'), 'Phoenix.PubSub -> :phoenix_pubsub: ' + names);
  assert.ok(names.includes('plug_cowboy'), 'PlugCowboy / Plug.Cowboy -> :plug_cowboy');
  assert.equal(names.length, 2, 'Phoenix.Socket matches neither :phoenix_pubsub nor anything else: ' + names);
});
