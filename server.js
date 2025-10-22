const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Modbus = require('modbus-serial');
const path = require('path');

const os = require('os');
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 静态文件服务
app.use(express.static('public'));
app.use('/libs/three', express.static(path.join(__dirname, 'node_modules/three')));
app.use('/libs/fflate', express.static(path.join(__dirname, 'node_modules/fflate')));

// PLC连接配置 - 西门子Smart200支持Modbus TCP
const PLC_CONFIG = {
    host: '192.168.0.2', // PLC IP地址
    port: 502,           // Modbus TCP默认端口
    unitId: 1            // 设备ID
};

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const ips = {
        ipv4: [],
        ipv6: []
    };
    
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            // 跳过内部（loopback）地址
            if (!interface.internal) {
                if (interface.family === 'IPv4') {
                    ips.ipv4.push(interface.address);
                } else if (interface.family === 'IPv6') {
                    ips.ipv6.push(interface.address);
                }
            }
        }
    }
    return ips;
}

const LOCAL_IPS = getLocalIP();
// 创建Modbus客户端
const client = new Modbus();
let isConnected = false;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;

// 连接PLC函数
async function connectToPLC() {
    try {
        await client.connectTCP(PLC_CONFIG.host, { port: PLC_CONFIG.port });
        client.setID(PLC_CONFIG.unitId);
        client.setTimeout(2000);
        isConnected = true;
        connectionAttempts = 0;
        console.log('成功连接到PLC');
        return true;
    } catch (error) {
        console.error('连接PLC失败:', error.message);
        isConnected = false;
        connectionAttempts++;
        return false;
    }
}

// 读取机器人关节数据函数 - 适配ABB RAPID代码
async function readRobotData() {
    if (!isConnected) {
        if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
            console.log('PLC未连接，尝试重新连接...');
            await connectToPLC();
            if (!isConnected) {
                return null;
            }
        } else {
            console.log('PLC连接失败次数过多');
            return null;
        }
    }

    try {
        // 根据RAPID代码，数据存储在地址100开始，共36个字节（18个寄存器）
        // 6个关节角度（每个4字节） + 3个位置坐标（每个4字节） = 36字节
        const response = await client.readHoldingRegisters(100, 18);
        
        // 创建36字节的Buffer
        const buffer = Buffer.alloc(36);
        for (let i = 0; i < response.data.length; i++) {
            // 每个寄存器是16位，写入到buffer中
            buffer.writeUInt16BE(response.data[i], i * 2);
        }
        
        // 解析数据 - RAPID代码中数据是按小端序存储的
        const robotData = {
            // 关节角度 (rax_1 到 rax_6)
            joint1: buffer.readFloatLE(0),   // rax_1
            joint2: buffer.readFloatLE(4),   // rax_2
            joint3: buffer.readFloatLE(8),   // rax_3
            joint4: buffer.readFloatLE(12),  // rax_4
            joint5: buffer.readFloatLE(16),  // rax_5
            joint6: buffer.readFloatLE(20),  // rax_6
            
            // 工具位置坐标
            // x: buffer.readFloatLE(24),       // lpos.trans.x
            // y: buffer.readFloatLE(28),       // lpos.trans.y
            // z: buffer.readFloatLE(32),       // lpos.trans.z
            
            timestamp: new Date().toISOString(),
            isMockData: false
        };
        
        console.log('读取到机器人数据:', {
            关节1: robotData.joint1.toFixed(2) + '°',
            关节2: robotData.joint2.toFixed(2) + '°',
            关节3: robotData.joint3.toFixed(2) + '°',
            关节4: robotData.joint4.toFixed(2) + '°',
            关节5: robotData.joint5.toFixed(2) + '°',
            关节6: robotData.joint6.toFixed(2) + '°',
            // 位置: `X:${robotData.x.toFixed(2)}mm, Y:${robotData.y.toFixed(2)}mm, Z:${robotData.z.toFixed(2)}mm`
        });
        
        return robotData;
    } catch (error) {
        console.error('读取PLC数据失败:', error.message);
        isConnected = false;
        return null;
    }
}

// 写入数据到PLC（控制机器人）- 适配ABB RAPID代码
// async function writeToPLC(address, value) {
//     if (!isConnected) {
//         console.log('PLC未连接，无法写入数据');
//         return false;
//     }

//     try {
//         // 将浮点数转换为两个16位寄存器（小端序，与RAPID代码匹配）
//         const buffer = Buffer.alloc(4);
//         buffer.writeFloatLE(value, 0);
        
//         const registers = [
//             buffer.readUInt16LE(0),
//             buffer.readUInt16LE(2)
//         ];
        
//         await client.writeRegisters(address, registers);
//         console.log(`成功写入数据到地址 ${address}: ${value}`);
//         return true;
//     } catch (error) {
//         console.error('写入PLC数据失败:', error);
//         return false;
//     }
// }

// 写入所有关节数据到PLC
// async function writeAllJoints(jointValues) {
//     if (!isConnected) {
//         console.log('PLC未连接，无法写入数据');
//         return false;
//     }

//     try {
//         // 假设关节数据写入地址从200开始（需要根据实际RAPID代码配置调整）
//         const baseAddress = 200;
        
//         for (let i = 0; i < jointValues.length; i++) {
//             const value = jointValues[i];
//             const address = baseAddress + (i * 2); // 每个浮点数占2个寄存器
            
//             // 将浮点数转换为两个16位寄存器（小端序）
//             const buffer = Buffer.alloc(4);
//             buffer.writeFloatLE(value, 0);
            
//             const registers = [
//                 buffer.readUInt16LE(0),
//                 buffer.readUInt16LE(2)
//             ];
            
//             await client.writeRegisters(address, registers);
//             console.log(`写入关节${i+1}到地址 ${address}: ${value}°`);
//         }
        
//         return true;
//     } catch (error) {
//         console.error('写入PLC数据失败:', error);
//         return false;
//     }
// }

// WebSocket连接处理
io.on('connection', (socket) => {
    console.log('客户端已连接:', socket.id);
    
    // 发送连接状态
    socket.emit('connectionStatus', {
        plcConnected: isConnected,
        message: isConnected ? 'PLC已连接' : 'PLC未连接'
    });
    
    // 定期发送机器人数据
    const interval = setInterval(async () => {
        let robotData;
        
        // 只读取真实PLC数据，不使用模拟数据
        if (isConnected) {
            robotData = await readRobotData();
        }
        
        // 如果PLC数据读取失败或未连接，不发送数据
        if (!robotData) {
            return;
        }
        
        socket.emit('robotData', robotData);
    }, 100); // 100ms更新频率
    
    // 处理来自客户端的控制命令
    // socket.on('controlCommand', async (data) => {
    //     console.log('收到控制命令:', data);
        
    //     if (data.type === 'writeJoint') {
    //         // 写入单个关节数据到PLC
    //         const success = await writeToPLC(data.address, data.value);
    //         socket.emit('commandResult', {
    //             success: success,
    //             message: success ? '命令执行成功' : '命令执行失败'
    //         });
    //     } else if (data.type === 'writeAllJoints') {
    //         // 写入所有关节数据到PLC
    //         const success = await writeAllJoints(data.jointValues);
    //         socket.emit('commandResult', {
    //             success: success,
    //             message: success ? '所有关节命令执行成功' : '关节命令执行失败'
    //         });
    //     } else if (data.type === 'setSpeed') {
    //         // 设置机器人速度（如果支持）
    //         const success = await writeToPLC(data.address, data.speed);
    //         socket.emit('commandResult', {
    //             success: success,
    //             message: success ? '速度设置成功' : '速度设置失败'
    //         });
    //     }
    // });
    
    // 处理客户端请求的实时数据
    socket.on('requestData', async () => {
        if (isConnected) {
            const robotData = await readRobotData();
            if (robotData) {
                socket.emit('robotData', robotData);
            }
        }
    });
    
    socket.on('disconnect', () => {
        console.log('客户端已断开连接:', socket.id);
        clearInterval(interval);
    });
});

// 启动时连接PLC
connectToPLC().then(success => {
    if (success) {
        console.log('PLC连接成功，开始提供数据服务');
    } else {
        console.log('PLC连接失败，将无法提供实时数据');
    }
});

// 健康检查端点
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        plcConnected: isConnected,
        serverTime: new Date().toISOString(),
        connectionAttempts: connectionAttempts
    });
});

// 手动触发数据读取端点（用于测试）
app.get('/read-data', async (req, res) => {
    try {
        const data = await readRobotData();
        if (data) {
            res.json({
                success: true,
                data: data
            });
        } else {
            res.json({
                success: false,
                message: '无法读取数据'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// 优雅关闭
process.on('SIGINT', async () => {
    console.log('正在关闭服务器...');
    if (client.isOpen) {
        await client.close();
        console.log('Modbus连接已关闭');
    }
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
    console.log(`请访问 http://localhost:${PORT} 查看3D可视化界面`);
    // 显示IPv4地址
    if (LOCAL_IPS.ipv4.length > 0) {
        console.log(`IPv4地址: http://${LOCAL_IPS.ipv4[0]}:${PORT}`);
    }
    // 显示IPv6地址
    if (LOCAL_IPS.ipv6.length > 0) {
        console.log(`IPv6地址: http://[${LOCAL_IPS.ipv6[0]}]:${PORT}`);
    }
});

module.exports = {
    readRobotData,
    // writeToPLC,
    // writeAllJoints,
    connectToPLC
};