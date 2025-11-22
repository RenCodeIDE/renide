# AI Editing Behavior Guidelines

## When "Edit" is Requested

When a user requests to **edit** a file (using words like "edit", "update", "change", "modify", "add to"), the AI assistant MUST:

1. **Use the `search_replace` tool** to make actual file edits
2. **NOT just explain** what changes should be made
3. **Execute the edit immediately** rather than only suggesting changes

## Edit Tool Usage

The primary tool for editing files is:
- **`search_replace`**: For making exact string replacements in files
  - Requires: `file_path`, `old_string`, `new_string`
  - Optionally: `replace_all` for replacing all occurrences

## Examples of Edit Requests

These phrases should trigger actual file edits:
- "Edit the file..."
- "Update..."
- "Change..."
- "Modify..."
- "Add to..."
- "Remove from..."
- "Replace..."
- "Fix..."

## Confirmation

After making edits, the AI should:
1. Confirm that the edit was made using the edit tool
2. Show what was changed
3. Check for linting errors if applicable

## File Editing in This Project

Recent edits made using `search_replace`:
- ✅ Added Configuration & Setup section to `REN_IDE_DEMO_GUIDE.md`
- ✅ Updated chat agent names from "Gemini" to "Agent" in multiple files
- ✅ Updated error messages to use "Agent" consistently

---

**Note**: This file serves as a reminder that the AI assistant should always use edit tools (`search_replace`, `write`, etc.) when the user requests file modifications, rather than only explaining what should be changed.




