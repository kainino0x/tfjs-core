/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

/// <reference types="@webgpu/types" />

import './flags_webgpu';

import {DataMover, DataType, ENV, KernelBackend, Rank, ShapeMap, Tensor, tensor1d, Tensor3D, Tensor4D, util} from '@tensorflow/tfjs-core';
import * as shaderc from '@webgpu/shaderc';

import * as binary_op from './kernels/binary_op_webgpu';
import {BinaryOpProgram} from './kernels/binary_op_webgpu';
import {Conv2DProgram} from './kernels/conv2d_webgpu';
import {MatMulProgram} from './kernels/matmul_webgpu';
import {PadProgram} from './kernels/pad_webgpu';
import * as unary_op from './kernels/unary_op_webgpu';
import {UnaryOpProgram} from './kernels/unary_op_webgpu';
import * as webgpu_program from './kernels/webgpu_program';
import {WebGPUBinary} from './kernels/webgpu_program';
import {Conv2DInfo} from '@tensorflow/tfjs-core/dist/ops/conv_util';

type TensorInfo = {
  shape: number[],
  dtype: DataType,
  values: Float32Array|Int32Array|Uint8Array,
  id: number,
  buffer: GPUBuffer
};

interface DataId {}

export class WebGPUBackend extends KernelBackend {
  device: GPUDevice;
  queue: GPUQueue;
  shaderc: shaderc.Shaderc;
  compiler: shaderc.Compiler;
  compileOpts: shaderc.CompileOptions;
  currentEncoder: {
    encoder: GPUCommandEncoder,
    pass: GPUComputePassEncoder,
    pipeline?: GPUComputePipeline,
  };

  private binaryCache: {[key: string]: WebGPUBinary};

  constructor(device: GPUDevice, shaderc: shaderc.Shaderc) {
    super();
    this.binaryCache = {};
    this.device = device;
    this.queue = device.getQueue();
    this.shaderc = shaderc;
    this.compiler = new shaderc.Compiler();
    const opts = new shaderc.CompileOptions();
    opts.SetOptimizationLevel(shaderc.optimization_level.performance);
    this.compileOpts = opts;
    this.newEncoder();
  }

  private newEncoder() {
    const encoder = this.device.createCommandEncoder({});
    this.currentEncoder = {
      encoder,
      pass: encoder.beginComputePass()
    };
  }

  floatPrecision(): 32 {
    return 32;
  }

  setDataMover(dataMover: DataMover): void {
    // TODO: tfjs team to implement this. Call GPUBuffer.destroy()
  }

  private tensorMap = new WeakMap<DataId, TensorInfo>();

  disposeData(dataId: DataId): void {
    // Tensor disposal logic.
  }

  private createBuffer(size: number) {
    return this.device.createBuffer({
      size,
      usage: GPUBufferUsage.TRANSFER_SRC | GPUBufferUsage.TRANSFER_DST |
          GPUBufferUsage.STORAGE,
    });
  }

  private setBufferData(
      buffer: GPUBuffer, data: Float32Array|Int32Array|Uint8Array) {
    buffer.setSubData(0, data);
  }

  register(dataId: object, shape: number[], dtype: DataType): void {
    if (!this.tensorMap.has(dataId)) {
      const buffer = this.createBuffer(
          util.sizeFromShape(shape) * util.bytesPerElement(dtype));

      this.tensorMap.set(dataId, {shape, dtype, values: null, id: -1, buffer});
    }
  }

  write(dataId: object, values: Float32Array|Int32Array|Uint8Array): void {
    if (!this.tensorMap.has(dataId)) {
      throw new Error(`Tensor ${dataId} was not registered!`);
    }

    const info = this.tensorMap.get(dataId);
    info.values = values;
    this.setBufferData(info.buffer, values);
    this.tensorMap.set(dataId, info);
  }

  private submitQueue() {
    this.queue.submit([this.currentEncoder.encoder.finish()]);
  }

  private async getBufferData(info: TensorInfo): Promise<ArrayBuffer> {
    const size =
        util.sizeFromShape(info.shape) * util.bytesPerElement(info.dtype);
    const staging = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.TRANSFER_DST | GPUBufferUsage.MAP_READ,
    });
    {
      this.submitQueue();
      const encoder = this.device.createCommandEncoder({});
      encoder.copyBufferToBuffer(info.buffer, 0, staging, 0, size);
      this.queue.submit([encoder.finish()]);
      this.newEncoder();
    }
    const mapped: ArrayBuffer = await staging.mapReadAsync();

    return mapped.slice(0);
  }

  async read(dataId: object): Promise<Float32Array|Int32Array|Uint8Array> {
    if (!this.tensorMap.has(dataId)) {
      throw new Error(`Tensor ${dataId} was not registered!`);
    }
    const info = this.tensorMap.get(dataId);
    const data = await this.getBufferData(info);

    return new Float32Array(data);
  }

  private getAndSavePipeline(
      key: string, getBinary: () => webgpu_program.WebGPUBinary) {
    if (!(key in this.binaryCache)) {
      this.binaryCache[key] = getBinary();
    }
    return this.binaryCache[key];
  }

  private makeOutputArray<T extends Tensor>(shape: number[], dtype: DataType):
      T {
    return Tensor.make(shape, {}, dtype, this) as T;
  }

  private compileAndRun<
      K extends {dtype: DataType, size: number, dataId: {}, shape: number[]}>(
      program: webgpu_program.WebGPUProgram,
      output: Tensor | null, inputs: Tensor[], uniforms?: Tensor): K {
    if (output == null) {
      output = this.makeOutputArray(program.outputShape, inputs[0].dtype);
    }
    const key = webgpu_program.makeShaderKey(program);
    const {bindGroupLayout, pipeline} = this.getAndSavePipeline(key, () => {
      return webgpu_program.compileProgram(
          this.compiler, this.shaderc.shader_kind.compute, this.compileOpts,
          this.device, program, output, inputs, uniforms);
    });

    const toBinding = (tensor: Tensor) => {
      const tensorData = this.tensorMap.get(tensor.dataId);

      return {
        resource: {
          offset: 0,
          size: tensor.size * util.bytesPerElement(tensor.dtype),
          buffer: tensorData.buffer
        }
      };
    };

    const bindings = [toBinding(output), ...inputs.map(toBinding)];
    if (uniforms) {
      bindings.push(toBinding(uniforms));
    }

    // Creating bind groups on the fly should never be a bottleneck.
    const bg = this.device.createBindGroup({
      layout: bindGroupLayout,
      bindings: bindings.map((b, i) => ({binding: i, ...b})),
    });

    const pass = this.currentEncoder.pass;
    if (this.currentEncoder.pipeline != pipeline) {
      pass.setPipeline(pipeline);
    }
    pass.setBindGroup(0, bg);
    pass.dispatch(
        program.dispatch[0], program.dispatch[1], program.dispatch[2]);

    if (ENV.get('WEBGPU_IMMEDIATE_EXECUTION_ENABLED')) {
      this.submitQueue();
      this.newEncoder();
    }
    return output as {} as K;
  }

  pad<T extends Tensor>(
      x: T, paddings: Array<[number, number]>, constantValue: number): T {
    const program = new PadProgram(x.shape, paddings, constantValue);
    return this.compileAndRun(program, null, [x]);
  }

  add(a: Tensor, b: Tensor): Tensor {
    const output = Tensor.make(a.shape, {}, a.dtype, this);
    const program = new BinaryOpProgram(binary_op.ADD, output.shape);

    return this.compileAndRun(program, output, [a, b]) as Tensor;
  }

  conv2d(x: Tensor4D, filter: Tensor4D, convInfo: Conv2DInfo): Tensor4D {
    const program = new Conv2DProgram(convInfo);
    const output = Tensor.make(convInfo.outShape, {}, x.dtype, this) as Tensor4D;

    const pad = convInfo.padInfo.type === 'VALID' ? [0, 0] :
        convInfo.padInfo.type === 'SAME' ? [
          -Math.floor((convInfo.filterShape[0] - 1) / 2),
          -Math.floor((convInfo.filterShape[1] - 1) / 2) ] :
        [convInfo.padInfo.top, convInfo.padInfo.left];
    const dimensions =
      tensor1d([
        ...convInfo.inShape,
        ...convInfo.outShape,
        convInfo.filterHeight, convInfo.filterWidth,
        ...pad,
        convInfo.strideHeight, convInfo.strideWidth,
      ], 'int32');

    return this.compileAndRun(program, output, [x, filter], dimensions) as Tensor4D;
  }

  multiply(a: Tensor, b: Tensor): Tensor {
    const output = Tensor.make(a.shape, {}, a.dtype, this);
    const program = new BinaryOpProgram(binary_op.MUL, output.shape);

    return this.compileAndRun(program, output, [a, b]) as Tensor;
  }

  relu<T extends Tensor>(x: T): T {
    const program = new UnaryOpProgram(unary_op.RELU, x.shape);
    return this.compileAndRun(program, null, [x]) as T;
  }

  reshape<R extends Rank>(x: Tensor, shape: ShapeMap[R]): Tensor<R> {
    return Tensor.make(shape, {dataId: x.dataId}, x.dtype);
  }

  batchMatMul(
      a: Tensor3D, b: Tensor3D, transposeA: boolean,
      transposeB: boolean): Tensor3D {
    const outerShapeA = transposeA ? a.shape[2] : a.shape[1];
    const outerShapeB = transposeB ? b.shape[1] : b.shape[2];
    const sharedDim = transposeA ? a.shape[1] : a.shape[2];
    const [batch, , ] = a.shape;

    const output =
        Tensor.make([batch, outerShapeA, outerShapeB], {}, a.dtype, this) as
        Tensor3D;

    const program = new MatMulProgram(output.shape);
    const dimensions =
        tensor1d([outerShapeA, sharedDim, outerShapeB, batch], 'int32');
    // TODO: dispose mnkb

    return this.compileAndRun(program, output, [a, b], dimensions) as Tensor3D;
  }
}