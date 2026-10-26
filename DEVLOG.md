# DEVLOG

内部开发日志，每个提交一条。

## fix(files-tree): 文件数超过上限时子文件夹被截掉

- 文件：`src-tauri/src/lib.rs`（`list_dir`）
- 原因：单目录条目上限 3000 在「读取顺序」中直接 `break`，之后才把文件夹排到前面。文件数超过上限时，排在后面的文件夹会整体消失。
- 改动：上限只计「文件」；子文件夹始终保留；超出时跳过多余文件并置 `truncated`。常量改名 `MAX_DIR_FILES`。
- 测试：`cargo test list_dir`（3/3 通过，含新增 `test_list_dir_keeps_all_folders_when_files_exceed_cap`）；`node scripts/run-tests.cjs file-tree dot-folders sidebar`（5/5 通过）。

## fix(files-tree): 指向文件夹的符号链接 / 目录联接被当成文件

- 文件：`src-tauri/src/lib.rs`（`list_dir`）
- 原因：`DirEntry::metadata()` 不跟随链接，链接的 `is_dir()` 为 false，被当成读不了的文件。
- 改动：遇到符号链接 / junction 时用 `std::fs::metadata` 跟随到目标取真实类型、大小、时间；悬空链接保留链接自身元数据。
- 测试：新增 `test_list_dir_symlinked_folder_is_listed_as_folder`（Windows 用 `mklink /J` 目录联接，无需管理员；已确认关闭修复时该测试会失败）。
- 未处理：`search_files` 仍不进入链接目录（避免循环）。

## feat(files-tree): 文件列表新增按大小排序

- 文件：`src/modules/files.js`、`src/modules/i18n-data.js`、`test/folder-sort.test.cjs`
- 排序下拉在「名称 / 修改时间 / 创建时间」之外新增「大小」（三语文案）。文件按大小排；文件夹没有有意义的大小，文件夹之间按名称，且仍置顶。升/降序按钮对其同样生效。
- 测试：`folder-sort` 新增 size 升/降序用例；`folder-sort file-tree dot-folders i18n` 6/6 通过。
