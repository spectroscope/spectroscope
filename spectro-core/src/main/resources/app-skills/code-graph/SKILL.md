---
name: code-graph
description: When and how to ask the code graph of this folder with the code_graph tool before reading many files
---

# Code graph

This folder has a code graph: a map of its classes, functions and files, and of how they call, import and contain each other. The `code_graph` tool asks that map about structure. One call can answer a question that would otherwise take many file reads.

## When to call it

Call `code_graph` before you read files when the question is about structure, for example:

- who calls a function, or what a class depends on
- how one part of the code reaches another
- what a change to a function or a file would affect
- where to start in code you have not read yet

Once the graph has named the places, read those files to check the details you need, such as an exact line or a value. When the question is about one file you already know, read that file directly.

## The actions

- `query` with `question`: a question in words that names the parts it is about, for example "how does PlaybookRunner reach the provider". `budget` (100 to 4000 tokens) keeps the answer short, and `dfs` follows one path deep instead of looking around wide.
- `path` with `from` and `to`: the shortest chain of calls, imports or containment between two nodes.
- `explain` with `name`: one node and its direct neighbors.
- `affected` with `name`: what depends on a node. `depth` (1 to 6) sets how many steps back the answer goes.
- `god_nodes`: the most connected nodes, and `top` (1 to 50) sets how many. It is a good first call in code you do not know.

## Phrasing a question

Name things the way the code names them: a class such as `PlaybookRunner`, a method such as `PlaybookRunner.step`, or a file such as `PlaybookRunner.java`. The graph matches nodes by name, so the exact spelling finds more than a description does. Ask one thing per call; a narrow question gets a short answer.

When a name is not found, try the class name alone, then a `query` in words.

## Limits

The graph shows the code as it was at the last build, and it holds code only, not documentation or images. If files changed since then, tell the person and suggest `/graph update`. The answer is the tool's text output, so check anything you plan to change in the file itself.
