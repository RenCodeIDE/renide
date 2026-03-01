## Ren IDE

**Ren IDE** is an AI-first, VS Code–compatible IDE that helps you **see your codebase as a graph**, get **AI-powered explanations and edits**, and **ship with confidence**.

This repository is a fork of the open-source [Visual Studio Code](https://github.com/microsoft/vscode) editor, with additional features focused on AI assistance and architecture-aware tooling.

Learn more on the website: [https://ren-ide.com/](https://ren-ide.com/)

---

## What Ren IDE adds on top of VS Code

- **AI coding assistant & chat**
  - Embedded chat that can navigate your workspace, read and edit files, and answer questions about the code.
  - Works on precise editor context (files, symbols, selections) instead of giant copy‑pasted prompts.
  - Uses a chunked Merkle tree of your code and a server-side vector store of code chunks to give the model fast, targeted access to relevant parts of the project.

- **Code graph & architecture views**
  - `renViews` architecture graph that renders your project as nodes and edges.
  - AI-enhanced architecture analysis:
    - Generates natural-language descriptions for components.
    - Identifies architecture patterns (e.g. MVC, layered, microservices-style boundaries).
    - Highlights layers and suggests improvements.

- **Smarter context for AI**
  - Code understanding is driven by the **graph of your codebase**, not just raw text.
  - AI features can reason about modules, dependencies, and impact of changes.

- **Optimized local dev experience**
  - macOS-optimized dev script using Bun for faster compilation.
  - Familiar VS Code build and debug workflow for hacking on the IDE itself.

Everything else you expect from VS Code (extensions, themes, debugging, terminals, etc.) continues to work via the underlying OSS codebase.

---

## Getting started (development)

These instructions are for developing and running **the IDE itself** from this repo.

### Prerequisites

- **Node.js** 22.x (to match the upstream VS Code toolchain)
- **npm**
- **Git**
- **Bun** (recommended on macOS for the fast dev script)
- A supported OS (macOS, Linux, or Windows)

> Platform details largely follow the upstream VS Code OSS build instructions.

### Clone and install

```bash
git clone https://github.com/<your-username>/renide.git
cd renide
npm install
```

### Fast macOS development

If you are on macOS, you can use the optimized script:

```bash
./scripts/dev-macos.sh
```

This will:

- Clean previous build output.
- Compile essential components with Bun.
- Start a watch process for live rebuilding.
- Launch Ren IDE in a new window.

### Generic dev workflow

If you prefer the standard VS Code-style dev loop:

```bash
# Terminal 1: build & watch
npm run watch

# Terminal 2: launch the desktop app
./scripts/code.sh --new-window
```

For web / server-style variants (mirroring VS Code’s web and server builds), you can also use:

```bash
./scripts/code-web.sh    # Web / browser-hosted
./scripts/code-server.sh # Server / headless
```

---

## Project structure (high level)

Some notable areas of this fork:

- **Core product configuration**
  - `product.json`: Branding (`Ren IDE`), application identifiers, extension gallery configuration, default chat agent, and Ren account settings.
  - `package.json`: Top-level npm scripts and dependencies for the Electron app and build pipeline.

- **AI & chat**
  - `src/vs/workbench/contrib/chat/`: Chat UX, agents, and language model tool integration.
  - `docs/parallel-tool-calls.md`: Design for how tool calls are executed in parallel with strong guarantees.

- **Ren architecture views**
  - `src/vs/workbench/contrib/renViews/browser/views/graphView/`: Code graph view, graph types, and rendering.
  - `src/vs/workbench/contrib/renViews/browser/views/graphView/aiArchitectureEnhancer.ts`: AI-powered architecture analysis and descriptions.
  - `src/vs/workbench/contrib/renViews/browser/services/CHUNK_HASH_PROPAGATION_PLAN.md`: Design doc for efficient chunk hash propagation and incremental updates.

- **Tooling & scripts**
  - `scripts/`: Dev, build, and test scripts (`code.sh`, `code-web.sh`, `code-server.sh`, `dev-macos.sh`, etc.).
  - `build/`: Gulp tasks, packaging logic, and validation scripts inherited from VS Code.

If you are familiar with the VS Code codebase, you should feel at home in this structure.

---

## Status

This fork is **under active development**. AI features, graph views, and workflows may change as the project evolves.

For a higher-level product overview, demos, and the latest roadmap, see: [https://ren-ide.com/](https://ren-ide.com/)

---

## Contributing

Contributions, bug reports, and feature requests are welcome.

- Open an issue or pull request on GitHub.
- If you know your way around VS Code OSS, you can treat this like a customized VS Code distribution with additional workbench contributions.

More detailed contributing and coding-style docs may be added over time.

---

## License

Ren IDE is built on top of the open-source [Visual Studio Code](https://github.com/microsoft/vscode) project and is licensed under the **MIT License**, matching the upstream project.

See the `LICENSE` file in this repository for the full text.

