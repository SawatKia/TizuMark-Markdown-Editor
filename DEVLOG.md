# DEVLOG

内部开发日志，每个提交一条。

## fix(files-tree): 文件数超过上限时子文件夹被截掉

- 文件：`src-tauri/src/lib.rs`（`list_dir`）
- 原因：单目录条目上限 3000 在「读取顺序」中直接 `break`，之后才把文件夹排到前面。文件数超过上限时，排在后面的文件夹会整体消失。
- 改动：上限只计「文件」；子文件夹始终保留；超出时跳过多余文件并置 `truncated`。常量改名 `MAX_DIR_FILES`。
- 测试：`cargo test list_dir`（3/3 通过，含新增 `test_list_dir_keeps_all_folders_when_files_exceed_cap`）；`node scripts/run-tests.cjs file-tree dot-folders sidebar`（5/5 通过）。
