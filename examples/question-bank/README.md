# 题库导入范例

`questions.json` 包含三道自编单选题：纯文字数学题、引用 `images/dots.png` 的图形题、引用 `images/loans.png` 的资料分析题。图片字段仅有相对路径。

`materials.json` 演示一篇材料关联三道小题：材料录入一次，小题使用 `materialId` 和 `materialOrder` 记录所属材料及顺序。

在仓库根目录运行：

```bash
npm run questions:import -- --input=examples/question-bank/questions.json --check
npm run questions:import -- --input=examples/question-bank/materials.json --check
npm run questions:import -- --input=examples/question-bank/questions.json --output=artifacts/example-bank
```

字段、增量合并与在线发布接口见 [导入说明](../../docs/QUESTION_IMPORT.md)。示例图片是程序绘制的测试图，题目并非历年真题。
