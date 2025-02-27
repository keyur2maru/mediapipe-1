/**
 * Copyright 2024 The MediaPipe Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Any} from 'google-protobuf/google/protobuf/any_pb';
import {CalculatorGraphConfig, InputStreamInfo,} from '../../../../framework/calculator_pb';
import {BaseOptions as BaseOptionsProto} from '../../../../tasks/cc/core/proto/base_options_pb';
import {CachedGraphRunner, TaskRunner,} from '../../../../tasks/web/core/task_runner';
import {WasmFileset} from '../../../../tasks/web/core/wasm_fileset';
import {LlmInferenceGraphOptions} from '../../../../tasks/web/genai/llm_inference/proto/llm_inference_graph_options_pb';
import {WasmModule} from '../../../../web/graph_runner/graph_runner';
import {StreamingReader, SupportStreamingReader} from '../../../../web/graph_runner/graph_runner_streaming_reader';
import {SupportWebGpu} from '../../../../web/graph_runner/graph_runner_webgpu';
import {DetokenizerCalculatorOptions} from '../../../../tasks/cc/genai/inference/calculators/detokenizer_calculator_pb';
import {LlmGpuCalculatorOptions} from '../../../../tasks/cc/genai/inference/calculators/llm_gpu_calculator_pb';
import {TokenizerCalculatorOptions} from '../../../../tasks/cc/genai/inference/calculators/tokenizer_calculator_pb';
import {LlmParameters} from '../../../../tasks/cc/genai/inference/proto/llm_params_pb';
import {SamplerParameters} from '../../../../tasks/cc/genai/inference/proto/sampler_params_pb';
import {TransformerParameters} from '../../../../tasks/cc/genai/inference/proto/transformer_params_pb';
// Placeholder for internal dependency on trusted resource url

import {LlmInferenceOptions} from './llm_inference_options';

export * from './llm_inference_options';

// The OSS JS API does not support the builder pattern.
// tslint:disable:jspb-use-builder-pattern

// TODO: b/327515383 - Use ReturnType patter to apply extensions to LLM Web API.
// tslint:disable-next-line:enforce-name-casing
const StreamingReaderWebGpuGraphRunnerType =
    SupportWebGpu(SupportStreamingReader(CachedGraphRunner));
class StreamingReaderWebGpuGraphRunner extends
    StreamingReaderWebGpuGraphRunnerType {}

/**
 * A listener that receives the newly generated partial result and an indication
 * whether the generation is complete.
 */
export type ProgressListener = (partialResult: string, done: boolean) =>
    unknown;

const INPUT_STREAM = 'text_in';
const OUTPUT_STREAM = 'text_out';
const OUTPUT_END_STREAM = 'text_end';

const TOKEN_COST_INPUT_STREAM = 'token_cost_in';
const TOKEN_COST_OUTPUT_STREAM = 'token_cost_out';

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_TOP_K = 1;
const DEFAULT_TOP_P = 1.0;
const DEFAULT_TEMPERATURE = 1.0;
const DEFAULT_SAMPLER_TYPE = SamplerParameters.Type.TOP_P;

/**
 * Performs LLM Inference on text.
 */
export class LlmInference extends TaskRunner {
  private static readonly TOKEN_SPLITTER =
      '▁';  // Note this is NOT an underscore: ▁(U+2581)
  private static readonly NEW_LINE = '<0x0A>';
  private static readonly EOD = '\\[eod\\]';
  private static readonly LLM_MODEL_NAME = 'llm.tflite';
  private static readonly TOKENIZER_MODEL_IN_TFLITE_KEY = 'spm_vocab_model';

  private readonly generationResult: string[] = [];
  private readonly options: LlmInferenceGraphOptions;
  private readonly samplerParams: SamplerParameters;
  private isProcessing = false;
  private latestTokenCostQueryResult?: number;
  private resolveGeneration?: (result: string) => void;
  private userProgressListener?: ProgressListener;
  private streamingReader?: StreamingReader;

  /**
   * Initializes the Wasm runtime and creates a new `LlmInference` based
   * on the provided options.
   * @export
   * @param wasmFileset A configuration object that provides the location of the
   *     Wasm binary and its loader.
   * @param llmInferenceOptions The options for LLM Inference. Note that
   *     either a path to the TFLite model or the model itself needs to be
   *     provided (via `baseOptions`).
   */
  static async createFromOptions(
      wasmFileset: WasmFileset,
      llmInferenceOptions: LlmInferenceOptions): Promise<LlmInference> {
    const optionsWithGpuDevice = llmInferenceOptions;
    // if the user provided options object does not have WebGPU device, clone a
    // new options object and add WebGPU device to the options.
    if (!optionsWithGpuDevice.baseOptions?.gpuOptions?.device) {
      const webgpuDevice = await LlmInference.createWebGpuDevice();
      optionsWithGpuDevice.baseOptions = llmInferenceOptions.baseOptions ?? {};
      optionsWithGpuDevice.baseOptions.gpuOptions =
          llmInferenceOptions?.baseOptions?.gpuOptions ?? {};
      optionsWithGpuDevice.baseOptions.gpuOptions.device = webgpuDevice;
    }

    return TaskRunner.createInstance(
        LlmInference, /* canvas= */ null, wasmFileset, optionsWithGpuDevice);
  }

  /**
   * Initializes the Wasm runtime and creates a new `LlmInference` based
   * on the provided model asset buffer.
   * @export
   * @param wasmFileset A configuration object that provides the location of the
   *     Wasm binary and its loader.
   * @param modelAssetBuffer A binary representation of the model.
   */
  static async createFromModelBuffer(
      wasmFileset: WasmFileset,
      modelAssetBuffer: Uint8Array): Promise<LlmInference> {
    const webgpuDevice = await LlmInference.createWebGpuDevice();
    const llmInferenceOptions = {
      baseOptions: {gpuOptions: {device: webgpuDevice}, modelAssetBuffer}
    };

    return TaskRunner.createInstance(
        LlmInference, /* canvas= */ null, wasmFileset, llmInferenceOptions);
  }

  /**
   * Initializes the Wasm runtime and creates a new `LlmInference` based
   * on the path to the model asset.
   * @export
   * @param wasmFileset A configuration object that provides the location of the
   *     Wasm binary and its loader.
   * @param modelAssetPath The path to the model asset.
   */
  static async createFromModelPath(
      wasmFileset: WasmFileset,
      modelAssetPath: string): Promise<LlmInference> {
    const webgpuDevice = await LlmInference.createWebGpuDevice();
    const llmInferenceOptions = {
      baseOptions: {gpuOptions: {device: webgpuDevice}, modelAssetPath}
    };

    return TaskRunner.createInstance(
        LlmInference, /* canvas= */ null, wasmFileset, llmInferenceOptions);
  }

  /** @hideconstructor */
  constructor(
      wasmModule: WasmModule,
      glCanvas?: HTMLCanvasElement|OffscreenCanvas|null) {
    super(new StreamingReaderWebGpuGraphRunner(wasmModule, glCanvas));
    this.options = new LlmInferenceGraphOptions();
    this.options.setBaseOptions(new BaseOptionsProto());
    this.samplerParams = new SamplerParameters();
    this.options.setSamplerParams(this.samplerParams);
    this.initDefaults();
  }

  /**
   * Create WebGPU device with high performance configurations.
   * @export
   */
  static createWebGpuDevice(): Promise<GPUDevice> {
    const adapterDescriptor:
        GPURequestAdapterOptions = {powerPreference: 'high-performance'};
    const deviceDescriptor: GPUDeviceDescriptor = {
      requiredFeatures: ['shader-f16'],
      requiredLimits: {
        'maxStorageBufferBindingSize': 524550144,
        'maxBufferSize': 524550144,
      },
    };
    return StreamingReaderWebGpuGraphRunner.requestWebGpuDevice(
        deviceDescriptor, adapterDescriptor);
  }

  /**
   * Sets new options for the LLM inference task.
   *
   * Calling `setOptions()` with a subset of options only affects those options.
   * You can reset an option back to its default value by explicitly setting it
   * to `undefined`.
   *
   * @export
   * @param options The options for the LLM Inference task.
   */
  override setOptions(options: LlmInferenceOptions): Promise<void> {
    // TODO: b/324482487 - Support customizing config for Web task of LLM
    // Inference.
    if (this.isProcessing) {
      throw new Error('Cannot set options while loading or processing.');
    }
    this.isProcessing = true;

    if (options.baseOptions?.gpuOptions?.device) {
      (this.graphRunner as unknown as StreamingReaderWebGpuGraphRunner)
          .initializeForWebGpu(options.baseOptions.gpuOptions.device);
    }
    if ('maxTokens' in options) {
      this.options.setMaxTokens(options.maxTokens ?? DEFAULT_MAX_TOKENS);
    }
    if ('topK' in options) {
      this.samplerParams.setK(options.topK ?? DEFAULT_TOP_K);
      if (options.topK && !options.randomSeed) {
        console.warn(
            `'topK' option ignored; it requires randomSeed to be set.`);
      }
    }
    if ('temperature' in options) {
      this.samplerParams.setTemperature(
          options.temperature ?? DEFAULT_TEMPERATURE);
      if (options.temperature && !options.randomSeed) {
        console.warn(
            `'temperature' option ignored; it requires randomSeed to be set.`);
      }
    }
    if (options.randomSeed) {
      this.samplerParams.setSeed(options.randomSeed);
    }

    let onFinishedLoadingData!: () => void;
    const finishedLoadingDataPromise = new Promise<void>((resolve, reject) => {
      onFinishedLoadingData = resolve;
    });
    if (options.baseOptions?.modelAssetPath ||
        options.baseOptions?.modelAssetBuffer) {
      if (options.baseOptions.modelAssetPath &&
          options.baseOptions.modelAssetBuffer) {
        throw new Error(
            'Cannot set both baseOptions.modelAssetPath and baseOptions.modelAssetBuffer');
      }
      if (options.baseOptions.modelAssetPath) {
        this.streamingReader = StreamingReader.loadFromUrl(
            options.baseOptions.modelAssetPath, onFinishedLoadingData);
      } else if (options.baseOptions.modelAssetBuffer) {
        this.streamingReader = StreamingReader.loadFromArray(
            options.baseOptions.modelAssetBuffer, onFinishedLoadingData);
        // Remove the reference on the asset buffer since it is now owned by
        // `streamingReader`.
        options.baseOptions.modelAssetBuffer = undefined;
      } else {
        onFinishedLoadingData();
      }
    }
    // To allow graph closure across ASYNCIFY, where we cannot get a callback,
    // we instead invoke it with a special mechanism and then wrap it into a
    // promise. We then chain the graph-refresh promise with our data-loading
    // promise so that a user can simply await the whole thing, and we block
    // isProcessing for the entire duration.
    const refreshGraphPromise = this.refreshGraph().then(() => {
      this.onGraphRefreshed();
    });
    // Note: this is triggered from within the final loading call, so the wasm
    // code hasn't quite finished running by this point in time. However, that
    // microtask seems to complete before any code await-ing this function, so
    // this should be fine. This seems to be similarly true for our
    // resolveGeneration usage as well.
    return finishedLoadingDataPromise.then(() => {
      refreshGraphPromise.then(() => {
        this.isProcessing = false;
      });
    });
  }

  protected override get baseOptions(): BaseOptionsProto {
    return this.options.getBaseOptions()!;
  }

  protected override set baseOptions(proto: BaseOptionsProto) {
    this.options.setBaseOptions(proto);
  }

  /**
   * Performs LLM Inference on the provided text and waits
   * asynchronously for the response. Only one call to `generateResponse()` can
   * run at a time.
   *
   * @export
   * @param text The text to process.
   * @return The generated text result.
   */
  generateResponse(text: string): Promise<string>;
  /**
   * Performs LLM Inference on the provided text and waits
   * asynchronously for the response. Only one call to `generateResponse()` can
   * run at a time.
   *
   * @export
   * @param text The text to process.
   * @param progressListener A listener that will be triggered when the task has
   *     new partial response generated.
   * @return The generated text result.
   */
  generateResponse(text: string, progressListener: ProgressListener):
      Promise<string>;
  /** @export */
  generateResponse(text: string, progressListener?: ProgressListener):
      Promise<string> {
    if (this.isProcessing) {
      throw new Error('Previous invocation or loading is still ongoing.');
    }
    if (progressListener) {
      this.userProgressListener = progressListener;
    }
    this.generationResult.length = 0;
    this.isProcessing = true;
    this.graphRunner.addStringToStream(
        text, INPUT_STREAM, this.getSynctheticTimestamp());
    this.finishProcessing();
    return new Promise<string>((resolve, reject) => {
      this.resolveGeneration = resolve;
    });
  }

  /**
   * Runs an invocation of *only* the tokenization for the LLM, and returns
   * the size (in tokens) of the result. Cannot be called while
   * a `generateResponse()` query is active. Runs synchronously.
   *
   * @export
   * @param text The text to tokenize.
   * @return The number of tokens in the resulting tokenization of the text.
   *         May return undefined if an error occurred.
   */
  sizeInTokens(text: string): number|undefined {
    if (this.isProcessing) {
      throw new Error('Previous invocation or loading is still ongoing.');
    }
    this.isProcessing = true;
    this.latestTokenCostQueryResult = undefined;
    this.graphRunner.addStringToStream(
        text,
        TOKEN_COST_INPUT_STREAM,
        this.getSynctheticTimestamp(),
    );
    this.finishProcessing();
    this.isProcessing = false;
    return this.latestTokenCostQueryResult;
  }

  /**
   * Decodes the response from the LLM engine and returns a human-readable
   * string.
   */
  private static decodeResponse(
      responses: string[], stripLeadingWhitespace: boolean): string {
    if (responses == null || responses.length === 0) {
      // Technically, this is an error. We should always get at least one
      // response.
      return '';
    }

    let response = responses[0];  // We only use the first response
    response = response.replaceAll(LlmInference.TOKEN_SPLITTER, ' ');
    response = response.replaceAll(
        LlmInference.NEW_LINE, '\n');  // Replace <0x0A> token with newline

    if (stripLeadingWhitespace) {
      response = response.trimStart();
    }

    return response.split(LlmInference.EOD, 1)[0];
  }

  /** Sets the default values for the graph. */
  private initDefaults(): void {
    this.options.setMaxTokens(DEFAULT_MAX_TOKENS);
    this.samplerParams.setType(DEFAULT_SAMPLER_TYPE);
    this.samplerParams.setK(DEFAULT_TOP_K);
    this.samplerParams.setP(DEFAULT_TOP_P);
    this.samplerParams.setTemperature(DEFAULT_TEMPERATURE);
  }

  // TODO: b/324919242 - Add sync API for BYOM Web API when Chrome JSPI is
  // available

  /** Updates the MediaPipe graph configuration. */
  protected override refreshGraph(): Promise<void> {
    const graphConfig = this.buildLlmInferenceGraph();

    this.graphRunner.attachStringVectorListener(
        OUTPUT_STREAM, (stringVector, timestamp) => {
          const stripLeadingWhitespace = this.generationResult.length === 0;
          const decodedText =
              LlmInference.decodeResponse(stringVector, stripLeadingWhitespace);
          this.generationResult.push(decodedText);
          if (this.userProgressListener) {
            this.userProgressListener(decodedText, /* done= */ false);
          }
          this.setLatestOutputTimestamp(timestamp);
        });
    this.graphRunner.attachEmptyPacketListener(OUTPUT_STREAM, timestamp => {
      this.setLatestOutputTimestamp(timestamp);
    });

    this.graphRunner.attachBoolListener(
        OUTPUT_END_STREAM, (bool, timestamp) => {
          this.isProcessing = false;
          if (this.resolveGeneration) {
            this.resolveGeneration(this.generationResult.join(''));
          }
          if (this.userProgressListener) {
            this.userProgressListener(
                /* partialResult= */ '', /* done= */ true);
          }
          this.setLatestOutputTimestamp(timestamp);
        });
    this.graphRunner.attachEmptyPacketListener(OUTPUT_END_STREAM, timestamp => {
      this.isProcessing = false;
      this.setLatestOutputTimestamp(timestamp);
    });

    this.graphRunner.attachIntListener(
        TOKEN_COST_OUTPUT_STREAM, (cost, timestamp) => {
          this.latestTokenCostQueryResult = cost;
          this.setLatestOutputTimestamp(timestamp);
        });

    if (this.streamingReader) {
      (this.graphRunner as unknown as StreamingReaderWebGpuGraphRunner)
          .addStreamingReaderToInputSidePacket(
              this.streamingReader,
              'streaming_reader',
          );
    }

    const binaryGraph = graphConfig.serializeBinary();

    // Due to ASYNCIFY usage, the normal closeGraph(), which is automatically
    // called by setGraph when changing a running graph, is not guaranteed to
    // have finished by the time the function returns. There is no easy way to
    // pipe through a completion callback like with other ASYNCIFY'ed calls. So
    // instead, we use a special async-only variant of closeGraph which we can
    // chain into our promises to ensure proper ordering, calling that first so
    // the built-in closeGraph becomes a no-op.
    return (this.graphRunner as unknown as StreamingReaderWebGpuGraphRunner)
        .closeGraphAsync().then(() => {
      this.setGraph(new Uint8Array(binaryGraph), /* isBinary= */ true);
      // Start initialization; this is async when StreamingReader is used.
      this.finishProcessing();
    });
  }

  private buildLlmInferenceGraph(): CalculatorGraphConfig {
    const graphConfig = new CalculatorGraphConfig();
    graphConfig.addInputStream(INPUT_STREAM);
    graphConfig.addInputStream(TOKEN_COST_INPUT_STREAM);
    graphConfig.addInputSidePacket('streaming_reader');
    graphConfig.addOutputStream(OUTPUT_STREAM);
    graphConfig.addOutputStream(OUTPUT_END_STREAM);
    graphConfig.addOutputStream(TOKEN_COST_OUTPUT_STREAM);

    // TokenizerInputBuilder Node
    const tokenizerInputBuildNode = new CalculatorGraphConfig.Node();
    tokenizerInputBuildNode.setCalculator('TokenizerInputBuildCalculator');
    tokenizerInputBuildNode.addInputStream(INPUT_STREAM);
    tokenizerInputBuildNode.addOutputStream('prompt');
    graphConfig.addNode(tokenizerInputBuildNode);

    // Model data Node
    const modelDataNode = new CalculatorGraphConfig.Node();
    modelDataNode.setCalculator('ModelDataCalculator');
    modelDataNode.addOutputSidePacket(
        'MODEL_DATA:' +
        '__side_packet_1');
    modelDataNode.addOutputSidePacket(
        'MODEL_TYPE:' +
        'model_type');
    modelDataNode.addInputSidePacket(
        'READ_DATA_FN:' +
        'streaming_reader');
    graphConfig.addNode(modelDataNode);

    // Tokenizer Node
    const gpt2NormalizationNode = new CalculatorGraphConfig.Node();
    gpt2NormalizationNode.setCalculator('Gpt2UnicodeMappingCalculator');
    gpt2NormalizationNode.addInputSidePacket(
        'MODEL_TYPE:' +
        'model_type');
    gpt2NormalizationNode.addOutputSidePacket(
        'BYTES_TO_UNICODE_MAPPING:' +
        'tokenizer_mapping');
    graphConfig.addNode(gpt2NormalizationNode);

    const tokenizerOptionsProto = new Any();
    tokenizerOptionsProto.setTypeUrl(
        'type.googleapis.com/odml.infra.proto.TokenizerCalculatorOptions');
    const tokenizerOptions = new TokenizerCalculatorOptions();
    tokenizerOptions.setMaxTokens(this.options.getMaxTokens());

    const modelFile = new TokenizerCalculatorOptions.TfLiteModelFile();
    modelFile.setSpmModelKeyInMetadata(
        LlmInference.TOKENIZER_MODEL_IN_TFLITE_KEY);
    tokenizerOptions.setTfliteModelFile(modelFile);

    tokenizerOptions.setStartTokenId(2);
    tokenizerOptionsProto.setValue(tokenizerOptions.serializeBinary());
    const tokenizerNode = new CalculatorGraphConfig.Node();
    tokenizerNode.setCalculator('TokenizerCalculator');
    tokenizerNode.addNodeOptions(tokenizerOptionsProto);
    tokenizerNode.addInputSidePacket(
        'MODEL_DATA:' +
        '__side_packet_1');
    tokenizerNode.addInputStream(
        'PROMPT_AND_INPUT_OPTIONS:' +
        'prompt');
    tokenizerNode.addInputSidePacket(
        'BYTES_TO_UNICODE_MAPPING:' +
        'tokenizer_mapping');
    tokenizerNode.addOutputSidePacket(
        'PROCESSOR_GETTER:' +
        '__input_side_1');
    tokenizerNode.addOutputStream(
        'IDS_AND_INPUT_OPTIONS:' +
        '__stream_0');
    graphConfig.addNode(tokenizerNode);

    // LlmGpu Node
    const llmGpuOptionsProto = new Any();
    llmGpuOptionsProto.setTypeUrl(
        'type.googleapis.com/odml.infra.proto.LlmGpuCalculatorOptions');
    const llmGpuOptions = new LlmGpuCalculatorOptions();

    llmGpuOptions.setNumDecodeTokens(3);
    llmGpuOptions.setWeightPath(LlmInference.LLM_MODEL_NAME);
    // Set seq batch size to 0 to use automated sequence batch search.
    llmGpuOptions.setSequenceBatchSize(0);
    llmGpuOptions.setNumOutputHeads(1);
    llmGpuOptions.setSamplerParams(this.options.getSamplerParams());

    const gpuModelInfo = new LlmGpuCalculatorOptions.GpuModelInfo();
    // Use fp16 inference by default but still allow fp32 inference if it's
    // required by the internal inference engine.
    gpuModelInfo.setAllowPrecisionLoss(true);
    gpuModelInfo.setEnableFastTuning(true);
    gpuModelInfo.setPreferTextureWeights(true);
    llmGpuOptions.setGpuModelInfo(gpuModelInfo);

    const llmParams = new LlmParameters();
    const transformerParams = new TransformerParameters();
    transformerParams.setBatchSize(1);
    transformerParams.setMaxSeqLength(this.options.getMaxTokens());
    llmParams.setTransformerParameters(transformerParams);
    llmGpuOptions.setLlmParameters(llmParams);

    llmGpuOptionsProto.setValue(llmGpuOptions.serializeBinary());
    const llmGpuNode = new CalculatorGraphConfig.Node();
    llmGpuNode.setCalculator('LlmGpuCalculator');
    llmGpuNode.addNodeOptions(llmGpuOptionsProto);
    llmGpuNode.addInputStream(
        'INPUT_PROMPT_IDS:' +
        '__stream_0');
    llmGpuNode.addInputStream(
        'FINISH:' +
        'finish');
    llmGpuNode.addInputSidePacket(
        'MODEL_DATA:' +
        '__side_packet_1');
    llmGpuNode.addOutputStream(
        'DECODED_IDS:' +
        '__stream_3');
    llmGpuNode.addOutputStream(
        'OUTPUT_END:' +
        '__stream_4');
    const backEdgeInputStreamInfo = new InputStreamInfo();
    backEdgeInputStreamInfo.setTagIndex('FINISH');
    backEdgeInputStreamInfo.setBackEdge(true);
    llmGpuNode.addInputStreamInfo(backEdgeInputStreamInfo);
    graphConfig.addNode(llmGpuNode);

    const isPacketPresentNode = new CalculatorGraphConfig.Node();
    isPacketPresentNode.setCalculator('IsPacketPresentCalculator');
    isPacketPresentNode.addInputStream('__stream_4');
    isPacketPresentNode.addOutputStream(OUTPUT_END_STREAM);
    graphConfig.addNode(isPacketPresentNode);

    // Detokenizer Node
    const detokenizerOptionsProto = new Any();
    detokenizerOptionsProto.setTypeUrl(
        'type.googleapis.com/odml.infra.proto.DetokenizerCalculatorOptions');
    const detokenizerOptions = new DetokenizerCalculatorOptions();
    detokenizerOptions.setNumOutputHeads(1);
    // No need to set spm model, instead reuse TokenizerCalculator's side input.
    detokenizerOptions.addStopTokens('<eos>');
    detokenizerOptions.addStopTokens('<|endoftext|>');
    detokenizerOptionsProto.setValue(detokenizerOptions.serializeBinary());
    const detokenizerNode = new CalculatorGraphConfig.Node();
    detokenizerNode.setCalculator('DetokenizerCalculator');
    detokenizerNode.addNodeOptions(detokenizerOptionsProto);
    detokenizerNode.addInputStream(
        'IDS_AND_INPUT_OPTIONS:' +
        '__stream_3');
    detokenizerNode.addInputSidePacket(
        'PROCESSOR_GETTER:' +
        '__input_side_1');
    detokenizerNode.addInputSidePacket(
        'BYTES_TO_UNICODE_MAPPING:' +
        'tokenizer_mapping');
    detokenizerNode.addInputSidePacket(
        'MODEL_DATA:' +
        '__side_packet_1');
    detokenizerNode.addOutputStream('FINISH_AND_INPUT_OPTIONS:finish');
    detokenizerNode.addOutputStream('WORDS:' + OUTPUT_STREAM);
    graphConfig.addNode(detokenizerNode);

    // TokenCost Node
    const tokenCostNode = new CalculatorGraphConfig.Node();
    tokenCostNode.setCalculator('TokenCostCalculator');
    tokenCostNode.addInputStream('PROMPT:' + TOKEN_COST_INPUT_STREAM);
    tokenCostNode.addInputSidePacket('PROCESSOR_GETTER:__input_side_1');
    tokenCostNode.addInputSidePacket('BYTES_TO_UNICODE_MAPPING:tokenizer_mapping');
    tokenCostNode.addOutputStream('NUM_TOKENS:' + TOKEN_COST_OUTPUT_STREAM);
    graphConfig.addNode(tokenCostNode);
    return graphConfig;
  }

  override close() {
    super.close();
  }
}


