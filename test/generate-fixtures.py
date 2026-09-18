"""Regenerate tiny original test models: onnx==1.22.0, tflite==2.18.0, flatbuffers==25.12.19."""
from pathlib import Path
import onnx
from onnx import helper, TensorProto
import flatbuffers
import tflite as t

out = Path(__file__).parent / "fixtures"
out.mkdir(exist_ok=True)
for name, weight, output_name in [("baseline", 1.0, "output"), ("candidate", 0.5, "output"), ("changed-interface", 1.0, "other")]:
    graph = helper.make_graph(
        [helper.make_node("MatMul", ["input", "weight"], [output_name])], "test",
        [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 2])],
        [helper.make_tensor_value_info(output_name, TensorProto.FLOAT, [1, 2])],
        [helper.make_tensor("weight", TensorProto.FLOAT, [2, 2], [weight, 0, 0, weight])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=9)
    onnx.checker.check_model(model)
    onnx.save(model, out / f"{name}.onnx")

b = flatbuffers.Builder(1024)
def ints(start, values):
    start(b, len(values))
    for v in reversed(values): b.PrependInt32(v)
    return b.EndVector()
def offsets(start, values):
    start(b, len(values))
    for v in reversed(values): b.PrependUOffsetTRelative(v)
    return b.EndVector()
tensors = []
for name in ["input", "output"]:
    label = b.CreateString(name)
    shape = ints(t.TensorStartShapeVector, [1, 2])
    t.TensorStart(b); t.TensorAddShape(b, shape); t.TensorAddType(b, t.TensorType.FLOAT32); t.TensorAddBuffer(b, 0); t.TensorAddName(b, label)
    tensors.append(t.TensorEnd(b))
inputs = ints(t.OperatorStartInputsVector, [0]); outputs = ints(t.OperatorStartOutputsVector, [1])
t.OperatorStart(b); t.OperatorAddOpcodeIndex(b, 0); t.OperatorAddInputs(b, inputs); t.OperatorAddOutputs(b, outputs)
op = t.OperatorEnd(b)
ops = offsets(t.SubGraphStartOperatorsVector, [op]); ts = offsets(t.SubGraphStartTensorsVector, tensors)
inputs = ints(t.SubGraphStartInputsVector, [0]); outputs = ints(t.SubGraphStartOutputsVector, [1])
t.SubGraphStart(b); t.SubGraphAddTensors(b, ts); t.SubGraphAddInputs(b, inputs); t.SubGraphAddOutputs(b, outputs); t.SubGraphAddOperators(b, ops)
graph = t.SubGraphEnd(b)
t.OperatorCodeStart(b); t.OperatorCodeAddBuiltinCode(b, t.BuiltinOperator.RELU); t.OperatorCodeAddDeprecatedBuiltinCode(b, t.BuiltinOperator.RELU); t.OperatorCodeAddVersion(b, 1)
code = t.OperatorCodeEnd(b)
t.BufferStart(b); buf = t.BufferEnd(b)
graphs = offsets(t.ModelStartSubgraphsVector, [graph]); codes = offsets(t.ModelStartOperatorCodesVector, [code]); buffers = offsets(t.ModelStartBuffersVector, [buf])
t.ModelStart(b); t.ModelAddVersion(b, 3); t.ModelAddSubgraphs(b, graphs); t.ModelAddOperatorCodes(b, codes); t.ModelAddBuffers(b, buffers)
model = t.ModelEnd(b); b.Finish(model, file_identifier=b"TFL3")
(out / "relu.tflite").write_bytes(bytes(b.Output()))
